import fs from "fs";
import crypto from "crypto";
import path from "path";
import { parse as parseCsv } from "csv-parse/sync";
import ExcelJS from "exceljs";
import { AttendanceSource, PunchType } from "@hr/shared";
import { prisma } from "../lib/prisma";
import { reconcileOvertimeCompletion } from "../modules/overtime/service";

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

export interface ImportPunchesOptions {
  fileName: string;
  fileHash?: string;
  importedBy?: string | null;
  source?: AttendanceSource;
}

/**
 * Shared entry point for the file watcher and the manual admin upload
 * endpoint — one insert/match/reconcile code path so behavior never
 * diverges between them. Unmatched device IDs are recorded in the review
 * queue, never dropped. Volumes here are small (one export at a time), so a
 * straightforward per-punch loop is fine — device polling uses
 * importDevicePunchesBatched instead, which is built for the thousands of
 * records a device poll re-reads every cycle.
 */
export async function importParsedPunches(
  punches: ParsedPunch[],
  opts: ImportPunchesOptions
): Promise<ImportResult> {
  const source = opts.source ?? AttendanceSource.IMPORT;
  let matchedCount = 0;
  let unmatchedCount = 0;
  // (staffId, calendar date) pairs that received an OVERTIME_IN/OVERTIME_OUT
  // punch in this import — reconciled against any APPROVED, not-yet-completed
  // OvertimeRequest once every row is in, so a request submitted for a date
  // that already has punches imported still gets auto-completed correctly.
  const otTouchedDays = new Map<string, { staffId: string; date: Date }>();

  const syncLog = await prisma.attendanceSyncLog.create({
    data: {
      fileName: opts.fileName,
      fileHash: opts.fileHash,
      processedCount: punches.length,
      matchedCount: 0,
      unmatchedCount: 0,
      importedBy: opts.importedBy ?? null,
    },
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
          source,
        },
      });
      matchedCount += 1;
      if (punch.punchType === PunchType.OVERTIME_IN || punch.punchType === PunchType.OVERTIME_OUT) {
        const dayKey = `${staff.id}|${punch.timestamp.toISOString().slice(0, 10)}`;
        otTouchedDays.set(dayKey, { staffId: staff.id, date: punch.timestamp });
      }
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

  for (const { staffId, date } of otTouchedDays.values()) {
    await reconcileOvertimeCompletion(staffId, date);
  }

  return { syncLogId: syncLog.id, processedCount: punches.length, matchedCount, unmatchedCount };
}

/**
 * Device-poll entry point. A device poll re-reads the terminal's entire
 * in-memory log every cycle (no "since last sync" cursor), so this runs at a
 * completely different scale than importParsedPunches — thousands of
 * records, most of which are already-imported repeats from earlier polls.
 * Doing a handful of batched queries (one Staff lookup, one existing-rows
 * lookup, two createMany calls) instead of several sequential round trips
 * *per punch* is the difference between a poll finishing in seconds versus
 * potentially hours over a remote (Supabase) connection.
 */
export async function importDevicePunchesBatched(
  punches: ParsedPunch[],
  opts: { fileName: string; source: AttendanceSource }
): Promise<ImportResult> {
  const syncLog = await prisma.attendanceSyncLog.create({
    data: { fileName: opts.fileName, processedCount: punches.length, matchedCount: 0, unmatchedCount: 0 },
  });

  if (punches.length === 0) {
    return { syncLogId: syncLog.id, processedCount: 0, matchedCount: 0, unmatchedCount: 0 };
  }

  const uniqueDeviceUserIds = [...new Set(punches.map((p) => p.deviceUserId))];

  const staffRows = await prisma.staff.findMany({
    where: { deviceUserId: { in: uniqueDeviceUserIds } },
    select: { id: true, deviceUserId: true },
  });
  const staffIdByDeviceUserId = new Map(staffRows.map((s) => [s.deviceUserId as string, s.id]));

  // AttendanceDevice is a registry/audit table, one row per device user id
  // (not per punch) — a small, bounded set even when the punch volume isn't.
  for (const deviceUserId of uniqueDeviceUserIds) {
    const staffId = staffIdByDeviceUserId.get(deviceUserId);
    await prisma.attendanceDevice.upsert({
      where: { deviceUserId },
      create: { deviceUserId, staffId },
      update: staffId ? { staffId } : {},
    });
  }

  const matchedStaffIds = [...staffIdByDeviceUserId.values()];
  const existingTimeEntries = matchedStaffIds.length
    ? await prisma.timeEntry.findMany({
        where: { staffId: { in: matchedStaffIds }, source: opts.source },
        select: { staffId: true, timestamp: true, punchType: true },
      })
    : [];
  // Keyed on (staff, instant) alone, deliberately NOT punchType — a single
  // physical tap on the device is already recorded once it's been imported
  // under any type, and must never be re-inserted just because a later poll
  // would now decode its type differently (e.g. after fixing how the type
  // byte itself is read). Re-typing already-imported history is a separate,
  // deliberate decision, not something a routine re-poll should ever do.
  const seenTimeEntryKeys = new Set(existingTimeEntries.map((e) => `${e.staffId}|${e.timestamp.getTime()}`));

  const existingUnmatched = await prisma.attendanceUnmatchedEntry.findMany({
    where: { deviceUserId: { in: uniqueDeviceUserIds } },
    select: { deviceUserId: true, timestamp: true, punchType: true },
  });
  const seenUnmatchedKeys = new Set(existingUnmatched.map((e) => `${e.deviceUserId}|${e.timestamp.getTime()}`));

  const timeEntriesToCreate: { staffId: string; timestamp: Date; punchType: PunchType; source: AttendanceSource }[] = [];
  const unmatchedToCreate: { syncLogId: string; deviceUserId: string; timestamp: Date; punchType: PunchType }[] = [];
  const otTouchedDays = new Map<string, { staffId: string; date: Date }>();

  for (const punch of punches) {
    const staffId = staffIdByDeviceUserId.get(punch.deviceUserId);
    if (staffId) {
      const key = `${staffId}|${punch.timestamp.getTime()}`;
      if (seenTimeEntryKeys.has(key)) continue;
      seenTimeEntryKeys.add(key); // also guards duplicate punches within this same poll
      timeEntriesToCreate.push({ staffId, timestamp: punch.timestamp, punchType: punch.punchType, source: opts.source });
      if (punch.punchType === PunchType.OVERTIME_IN || punch.punchType === PunchType.OVERTIME_OUT) {
        const dayKey = `${staffId}|${punch.timestamp.toISOString().slice(0, 10)}`;
        otTouchedDays.set(dayKey, { staffId, date: punch.timestamp });
      }
    } else {
      const key = `${punch.deviceUserId}|${punch.timestamp.getTime()}`;
      if (seenUnmatchedKeys.has(key)) continue;
      seenUnmatchedKeys.add(key);
      unmatchedToCreate.push({
        syncLogId: syncLog.id,
        deviceUserId: punch.deviceUserId,
        timestamp: punch.timestamp,
        punchType: punch.punchType,
      });
    }
  }

  if (timeEntriesToCreate.length) await prisma.timeEntry.createMany({ data: timeEntriesToCreate });
  if (unmatchedToCreate.length) await prisma.attendanceUnmatchedEntry.createMany({ data: unmatchedToCreate });

  const matchedCount = timeEntriesToCreate.length;
  const unmatchedCount = unmatchedToCreate.length;

  await prisma.attendanceSyncLog.update({ where: { id: syncLog.id }, data: { matchedCount, unmatchedCount } });

  for (const { staffId, date } of otTouchedDays.values()) {
    await reconcileOvertimeCompletion(staffId, date);
  }

  return { syncLogId: syncLog.id, processedCount: punches.length, matchedCount, unmatchedCount };
}

/**
 * Shared entry point for both the file-watcher and the manual admin upload
 * endpoint — one code path, so behavior never diverges between the two.
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

  return importParsedPunches(punches, { fileName, fileHash, importedBy });
}
