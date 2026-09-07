import fs from "fs";
import crypto from "crypto";
import path from "path";
import { parse as parseCsv } from "csv-parse/sync";
import ExcelJS from "exceljs";
import { PunchType } from "@hr/shared";
import { prisma } from "../lib/prisma";

export interface ParsedPunch {
  deviceUserId: string;
  timestamp: Date;
  punchType: PunchType;
}

export interface ImportResult {
  syncLogId: string;
  processedCount: number;
  matchedCount: number;
  unmatchedCount: number;
  duplicate?: boolean;
}

// Applied regardless of how the file arrived (watched folder or manual
// upload) — the manual-upload multer config has its own limit too, but the
// watcher has no equivalent gate on its own, so it lives here where both
// paths go through it.
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

// ZKTime 5.0 exports vary by device/firmware configuration, so header
// matching is case-insensitive and tries several common column names rather
// than assuming one fixed schema.
const USER_ID_HEADERS = ["device user id", "user id", "ac-no", "enroll number", "pin", "badge number"];
const TIME_HEADERS = ["time", "date/time", "timestamp", "check time", "punch time"];
const STATUS_HEADERS = ["status", "punch type", "c/i c/o", "state", "check type"];

// Numeric codes match the ZKTeco/ZKTime 5.0 firmware standard: 0=Check In,
// 1=Check Out, 2=Break Out, 3=Break In, 4=Overtime In, 5=Overtime Out.
const PUNCH_TYPE_VALUES: Record<string, PunchType> = {
  "check in": PunchType.CHECK_IN,
  "c/in": PunchType.CHECK_IN,
  "checkin": PunchType.CHECK_IN,
  "in": PunchType.CHECK_IN,
  "0": PunchType.CHECK_IN,
  "check out": PunchType.CHECK_OUT,
  "c/out": PunchType.CHECK_OUT,
  "checkout": PunchType.CHECK_OUT,
  "out": PunchType.CHECK_OUT,
  "1": PunchType.CHECK_OUT,
  "break out": PunchType.BREAK_OUT,
  "breakout": PunchType.BREAK_OUT,
  "2": PunchType.BREAK_OUT,
  "break in": PunchType.BREAK_IN,
  "breakin": PunchType.BREAK_IN,
  "3": PunchType.BREAK_IN,
  "overtime in": PunchType.OVERTIME_IN,
  "ot in": PunchType.OVERTIME_IN,
  "otin": PunchType.OVERTIME_IN,
  "4": PunchType.OVERTIME_IN,
  "overtime out": PunchType.OVERTIME_OUT,
  "ot out": PunchType.OVERTIME_OUT,
  "otout": PunchType.OVERTIME_OUT,
  "5": PunchType.OVERTIME_OUT,
};

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase();
}

function findColumn(headers: string[], candidates: string[]): number {
  const normalized = headers.map(normalizeHeader);
  for (const candidate of candidates) {
    const idx = normalized.indexOf(candidate);
    if (idx !== -1) return idx;
  }
  return -1;
}

function parsePunchType(raw: string | undefined, fallbackIndexInDay: number): PunchType {
  if (raw) {
    const mapped = PUNCH_TYPE_VALUES[raw.trim().toLowerCase()];
    if (mapped) return mapped;
  }
  // No recognizable status column — fall back to strict Check In/Check Out
  // alternation per device per day (common for bare punch-log exports with
  // no direction column; breaks/overtime can't be guessed without one).
  return fallbackIndexInDay % 2 === 0 ? PunchType.CHECK_IN : PunchType.CHECK_OUT;
}

function parseTimestamp(raw: unknown): Date | null {
  if (raw instanceof Date) return raw;
  if (typeof raw === "number") {
    // Excel serial date (exceljs sometimes returns numbers for date cells
    // depending on how the source file encoded them).
    return new Date(Math.round((raw - 25569) * 86400 * 1000));
  }
  if (typeof raw === "string") {
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function hashFile(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export async function readRows(filePath: string): Promise<{ headers: string[]; rows: unknown[][] }> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".csv") {
    const content = fs.readFileSync(filePath, "utf8");
    const records: string[][] = parseCsv(content, { skip_empty_lines: true });
    return { headers: records[0] ?? [], rows: records.slice(1) };
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  const rows: unknown[][] = [];
  let headers: string[] = [];
  sheet.eachRow((row, rowNumber) => {
    const values = (row.values as unknown[]).slice(1); // exceljs pads index 0
    if (rowNumber === 1) {
      headers = values.map((v) => String(v ?? ""));
    } else {
      rows.push(values);
    }
  });
  return { headers, rows };
}

export function toParsedPunches(headers: string[], rows: unknown[][]): { punches: ParsedPunch[]; skipped: number } {
  const userIdIdx = findColumn(headers, USER_ID_HEADERS);
  const timeIdx = findColumn(headers, TIME_HEADERS);
  const statusIdx = findColumn(headers, STATUS_HEADERS);

  if (userIdIdx === -1 || timeIdx === -1) {
    throw new Error(
      `Could not find required columns in export. Expected a user-id column (one of: ${USER_ID_HEADERS.join(", ")}) and a time column (one of: ${TIME_HEADERS.join(", ")}).`
    );
  }

  const punches: ParsedPunch[] = [];
  let skipped = 0;
  const dayIndexByDeviceDay = new Map<string, number>();

  for (const row of rows) {
    const deviceUserId = String(row[userIdIdx] ?? "").trim();
    const timestamp = parseTimestamp(row[timeIdx]);
    if (!deviceUserId || !timestamp) {
      skipped += 1;
      continue;
    }
    const dayKey = `${deviceUserId}:${timestamp.toISOString().slice(0, 10)}`;
    const idxInDay = dayIndexByDeviceDay.get(dayKey) ?? 0;
    dayIndexByDeviceDay.set(dayKey, idxInDay + 1);

    const statusRaw = statusIdx !== -1 ? String(row[statusIdx] ?? "") : undefined;
    punches.push({
      deviceUserId,
      timestamp,
      punchType: parsePunchType(statusRaw, idxInDay),
    });
  }

  return { punches, skipped };
}

/**
 * Shared entry point for both the file-watcher and the manual admin upload
 * endpoint — one code path, so behavior never diverges between the two.
 * Unmatched device IDs are recorded in the review queue, never dropped.
 *
 * Guards against re-processing the same export twice (e.g. a human
 * re-uploading a file they already imported) via a content hash independent
 * of which directory/path the file arrived through, and always creates an
 * AttendanceSyncLog row — even on failure — so a bad import is visible in
 * the admin UI instead of only a server log line.
 */
export async function processZKTimeFile(filePath: string, importedBy: string | null = null): Promise<ImportResult> {
  const fileName = path.basename(filePath);

  const sizeBytes = fs.statSync(filePath).size;
  if (sizeBytes > MAX_IMPORT_BYTES) {
    const syncLog = await prisma.attendanceSyncLog.create({
      data: {
        fileName,
        processedCount: 0,
        matchedCount: 0,
        unmatchedCount: 0,
        importedBy,
        failed: true,
        failureReason: `File too large (${sizeBytes} bytes, max ${MAX_IMPORT_BYTES}).`,
      },
    });
    throw Object.assign(new Error("file_too_large"), { syncLogId: syncLog.id });
  }

  const fileHash = hashFile(filePath);
  const existing = await prisma.attendanceSyncLog.findFirst({ where: { fileHash, failed: false } });
  if (existing) {
    return {
      syncLogId: existing.id,
      processedCount: existing.processedCount,
      matchedCount: existing.matchedCount,
      unmatchedCount: existing.unmatchedCount,
      duplicate: true,
    };
  }

  let punches: ParsedPunch[];
  try {
    const { headers, rows } = await readRows(filePath);
    punches = toParsedPunches(headers, rows).punches;
  } catch (err) {
    await prisma.attendanceSyncLog.create({
      data: {
        fileName,
        fileHash,
        processedCount: 0,
        matchedCount: 0,
        unmatchedCount: 0,
        importedBy,
        failed: true,
        failureReason: (err as Error).message,
      },
    });
    throw err;
  }

  let matchedCount = 0;
  let unmatchedCount = 0;

  const syncLog = await prisma.attendanceSyncLog.create({
    data: { fileName, fileHash, processedCount: punches.length, matchedCount: 0, unmatchedCount: 0, importedBy },
  });

  for (const punch of punches) {
    // Staff.deviceUserId is the source of truth for matching — it's set
    // directly on provisioning and kept in sync by resolveUnmatched().
    // AttendanceDevice is a registry/audit table for admin visibility, not
    // itself the match source, so an import never silently misses a staff
    // member whose deviceUserId was set without a corresponding
    // AttendanceDevice row (e.g. via direct staff provisioning or seeding).
    const staff = await prisma.staff.findUnique({
      where: { deviceUserId: punch.deviceUserId },
      select: { id: true },
    });

    await prisma.attendanceDevice.upsert({
      where: { deviceUserId: punch.deviceUserId },
      create: { deviceUserId: punch.deviceUserId, staffId: staff?.id },
      update: staff ? { staffId: staff.id } : {},
    });

    if (staff) {
      await prisma.timeEntry.create({
        data: {
          staffId: staff.id,
          timestamp: punch.timestamp,
          punchType: punch.punchType,
          source: "IMPORT",
        },
      });
      matchedCount += 1;
    } else {
      await prisma.attendanceUnmatchedEntry.create({
        data: {
          syncLogId: syncLog.id,
          deviceUserId: punch.deviceUserId,
          timestamp: punch.timestamp,
          punchType: punch.punchType,
        },
      });
      unmatchedCount += 1;
    }
  }

  await prisma.attendanceSyncLog.update({
    where: { id: syncLog.id },
    data: { matchedCount, unmatchedCount },
  });

  return { syncLogId: syncLog.id, processedCount: punches.length, matchedCount, unmatchedCount };
}
