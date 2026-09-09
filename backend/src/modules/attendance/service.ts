import fs from "fs";
import path from "path";
import ExcelJS from "exceljs";
import { AuthUser, NotificationType, PunchType, Role } from "@hr/shared";
import { prisma } from "../../lib/prisma";
import { canAccessStaffRecord } from "../../lib/rbac";
import { recordAudit } from "../../lib/audit";
import { notify } from "../../lib/notifications";
import { HttpError } from "../../lib/errors";
import { nextApprovalStatus } from "../../lib/approvalChain";
import { endOfUtcDay, payPeriodRange } from "../../lib/dateRange";
import { buildTablePdf } from "../../lib/pdf";
import { buildReportExcel } from "../../lib/reportExcel";
import { formatHmOrDash } from "../../lib/hoursFormat";
import { decryptField } from "../../lib/encryption";
import { env } from "../../lib/env";
import { processZKTimeFile } from "../../jobs/zktimeImport";
import { holidayTypeMap, listHolidays, holidayTypeMapForCategory, resolveDayType } from "../holidays/service";
import { buildTimesheet, shiftSettingsFor } from "./timesheet";
import { reconcileOvertimeCompletion, otRateInfoForStaffIds } from "../overtime/service";
import type { correctionSchema } from "./validation";
import type { z } from "zod";

type AuditMeta = { ipAddress?: string; userAgent?: string };

/** HR/Admin-only (see the route's requireRole gate) — regular staff have no
 * self-service way to punch or otherwise manually create a TimeEntry; their
 * only path to a manual attendance edit is a correction request, which
 * still requires HR/Admin's final approval (see reviewCorrection). With six
 * distinct punch types across three independent pairs (regular, break,
 * overtime), there's no single sane "toggle the last punch" guess the way a
 * plain IN/OUT clock could — the caller always says which of the six they
 * mean. */
export async function clockPunch(actor: AuthUser, punchType: PunchType) {
  const entry = await prisma.timeEntry.create({
    data: { staffId: actor.staffId, timestamp: new Date(), punchType, source: "MANUAL" },
  });
  return entry;
}

async function resolveTargetStaffId(requester: AuthUser, requestedStaffId?: string): Promise<string> {
  if (!requestedStaffId || requestedStaffId === requester.staffId) return requester.staffId;
  const target = await prisma.staff.findUnique({ where: { id: requestedStaffId } });
  if (!target) throw new HttpError(404, "not_found");
  if (!canAccessStaffRecord(requester, target.id, target.departmentId)) {
    throw new HttpError(403, "forbidden");
  }
  return target.id;
}

export async function getTimesheet(requester: AuthUser, requestedStaffId: string | undefined, from: Date, to: Date) {
  const staffId = await resolveTargetStaffId(requester, requestedStaffId);
  const staff = await prisma.staff.findUnique({ where: { id: staffId }, include: { staffGroup: true } });
  const [entries, holidays] = await Promise.all([
    prisma.timeEntry.findMany({
      where: { staffId, timestamp: { gte: from, lte: endOfUtcDay(to) } },
      orderBy: { timestamp: "asc" },
    }),
    holidayTypeMap(from, to, staff?.category ?? "NON_TEACHING"),
  ]);
  return buildTimesheet(entries, shiftSettingsFor(staff?.staffGroup ?? null), holidays);
}

export async function exportTimesheetCsv(requester: AuthUser, requestedStaffId: string | undefined, from: Date, to: Date) {
  const days = await getTimesheet(requester, requestedStaffId, from, to);
  const header = "Date,First In,Last Out,Hours Worked,Break Hours,OT Punched Hours,Late Arrival,Early Departure,Overtime Hours";
  const rows = days.map((d) =>
    [
      d.date,
      d.firstIn ?? "",
      d.lastOut ?? "",
      d.hoursWorked,
      d.breakHours,
      d.otPunchedHours,
      d.lateArrival,
      d.earlyDeparture,
      d.overtimeHours,
    ]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(",")
  );
  return [header, ...rows].join("\n");
}

export async function exportTimesheetPdf(
  requester: AuthUser,
  requestedStaffId: string | undefined,
  from: Date,
  to: Date
): Promise<Buffer> {
  const staffId = await resolveTargetStaffId(requester, requestedStaffId);
  const staff = await prisma.staff.findUnique({ where: { id: staffId }, select: { fullName: true, staffId: true } });
  const days = await getTimesheet(requester, requestedStaffId, from, to);

  const totalHours = Math.round(days.reduce((sum, d) => sum + d.hoursWorked, 0) * 100) / 100;
  const totalOvertime = Math.round(days.reduce((sum, d) => sum + d.overtimeHours, 0) * 100) / 100;

  return buildTablePdf({
    title: "Timesheet",
    subtitle: `${staff?.fullName ?? staffId} (${staff?.staffId ?? ""}) — ${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)}`,
    columns: [
      { header: "Date", width: 80 },
      { header: "First In", width: 90 },
      { header: "Last Out", width: 90 },
      { header: "Hours", width: 60 },
      { header: "Flags", width: 100 },
    ],
    rows: days.map((d) => [
      d.date,
      d.firstIn ? new Date(d.firstIn).toLocaleTimeString() : "—",
      d.lastOut ? new Date(d.lastOut).toLocaleTimeString() : "—",
      d.hoursWorked,
      [
        d.lateArrival && "Late",
        d.missingCheckout && "Missing checkout",
        d.earlyDeparture && "Early leave",
        d.breakHours > 0 && `${d.breakHours}h break`,
        d.otPunchedHours > 0 && `${d.otPunchedHours}h OT punched`,
        d.overtimeHours > 0 && `+${d.overtimeHours}h OT`,
      ]
        .filter(Boolean)
        .join(", "),
    ]),
    totalsRow: ["Total", "", "", totalHours, `${totalOvertime}h overtime`],
  });
}

export async function getDepartmentDashboard(requester: AuthUser, departmentId: string | undefined, from: Date, to: Date) {
  let deptId = departmentId;
  if (requester.role === Role.HOD) {
    deptId = requester.departmentId ?? "__none__";
  } else if (requester.role !== Role.HR_ADMIN) {
    throw new HttpError(403, "forbidden");
  }

  const [staffList, holidayRows] = await Promise.all([
    prisma.staff.findMany({
      // Resigned/terminated staff have no reason to appear on a "who
      // worked" roster — their attendance history stays intact, just
      // excluded from active-staff views like this one.
      where: { status: "ACTIVE", ...(deptId ? { departmentId: deptId } : {}) },
      select: { id: true, fullName: true, staffId: true, designation: true, staffGroup: true, category: true },
      orderBy: { staffId: "asc" },
    }),
    listHolidays(from, to),
  ]);

  const rows = await Promise.all(
    staffList.map(async (s) => {
      const entries = await prisma.timeEntry.findMany({
        where: { staffId: s.id, timestamp: { gte: from, lte: endOfUtcDay(to) } },
        orderBy: { timestamp: "asc" },
      });
      const holidays = holidayTypeMapForCategory(holidayRows, s.category);
      const days = buildTimesheet(entries, shiftSettingsFor(s.staffGroup), holidays);
      return {
        staffId: s.id,
        staffCode: s.staffId,
        fullName: s.fullName,
        designation: s.designation,
        daysPresent: days.filter((d) => d.hoursWorked > 0).length,
        totalHours: Math.round(days.reduce((sum, d) => sum + d.hoursWorked, 0) * 100) / 100,
        lateCount: days.filter((d) => d.lateArrival).length,
        earlyDepartureCount: days.filter((d) => d.earlyDeparture).length,
        overtimeHours: Math.round(days.reduce((sum, d) => sum + d.overtimeHours, 0) * 100) / 100,
      };
    })
  );

  return rows;
}

/**
 * One row per staff member for a single calendar day — HR_ADMIN (school-
 * wide) or HOD (own department only), same scoping as getDepartmentDashboard.
 * Unlike that function (which only aggregates counts over a range), this
 * returns full punch-level detail per person, including staff who didn't
 * punch at all that day (present: false, no punches) — buildTimesheet only
 * ever returns a day for someone who has at least one entry, so absent
 * staff need their holiday/type resolved independently via resolveDayType.
 */
export async function getDailyAttendance(requester: AuthUser, departmentId: string | undefined, date: Date) {
  let deptId = departmentId;
  if (requester.role === Role.HOD) {
    deptId = requester.departmentId ?? "__none__";
  } else if (requester.role !== Role.HR_ADMIN) {
    throw new HttpError(403, "forbidden");
  }

  const [staffList, holidayRows] = await Promise.all([
    prisma.staff.findMany({
      // Same reasoning as getDepartmentDashboard — resigned/terminated
      // staff are excluded from this roster, not deleted.
      where: { status: "ACTIVE", ...(deptId ? { departmentId: deptId } : {}) },
      select: { id: true, fullName: true, staffId: true, designation: true, staffGroup: true, category: true },
      orderBy: { staffId: "asc" },
    }),
    listHolidays(date, date),
  ]);

  const rows = await Promise.all(
    staffList.map(async (s) => {
      const entries = await prisma.timeEntry.findMany({
        where: { staffId: s.id, timestamp: { gte: date, lte: endOfUtcDay(date) } },
        orderBy: { timestamp: "asc" },
      });
      const holidayTypes = holidayTypeMapForCategory(holidayRows, s.category);
      const day = buildTimesheet(entries, shiftSettingsFor(s.staffGroup), holidayTypes)[0] ?? null;
      const holidayType = day?.holidayType ?? resolveDayType(date, holidayTypes);

      return {
        staffId: s.id,
        staffCode: s.staffId,
        fullName: s.fullName,
        designation: s.designation,
        present: !!(day?.firstIn || day?.lastOut),
        firstIn: day?.firstIn ?? null,
        lastOut: day?.lastOut ?? null,
        punches: day?.punches ?? [],
        hoursWorked: day?.hoursWorked ?? 0,
        breakHours: day?.breakHours ?? 0,
        otPunchedHours: day?.otPunchedHours ?? 0,
        lateArrival: day?.lateArrival ?? false,
        missingCheckout: day?.missingCheckout ?? false,
        earlyDeparture: day?.earlyDeparture ?? false,
        overtimeHours: day?.overtimeHours ?? 0,
        isHoliday: holidayType !== null,
        holidayType,
        holidayAttendanceEligible: day?.holidayAttendanceEligible ?? false,
        overtimeEligible: day?.overtimeEligible ?? false,
      };
    })
  );

  return rows;
}

function attendancePeriodLabel(from: Date, to: Date): string {
  const fmt = (d: Date) => `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
  return `${fmt(from)} to ${fmt(to)}`;
}

/** School-wide attendance report — one row per staff for the date range,
 * built on the same per-staff aggregation as the Department Dashboard. */
export async function attendanceReportPdf(requester: AuthUser, departmentId: string | undefined, from: Date, to: Date): Promise<Buffer> {
  const rows = await getDepartmentDashboard(requester, departmentId, from, to);
  const totalHours = Math.round(rows.reduce((s, r) => s + r.totalHours, 0) * 100) / 100;
  const totalOvertime = Math.round(rows.reduce((s, r) => s + r.overtimeHours, 0) * 100) / 100;
  return buildTablePdf({
    title: "Attendance Report",
    subtitle: `Kinbidhoo School — ${attendancePeriodLabel(from, to)}`,
    columns: [
      { header: "#", width: 20 },
      { header: "Staff ID", width: 55 },
      { header: "Name", width: 100 },
      { header: "Designation", width: 90 },
      { header: "Days Present", width: 50 },
      { header: "Total Hours", width: 50 },
      { header: "Late", width: 35 },
      { header: "Early Leave", width: 55 },
      { header: "Overtime Hrs", width: 55 },
    ],
    rows: rows.map((r, i) => [i + 1, r.staffCode, r.fullName, r.designation, r.daysPresent, r.totalHours, r.lateCount, r.earlyDepartureCount, r.overtimeHours]),
    totalsRow: ["", "", "", "Total", "", totalHours, "", "", totalOvertime],
    signoff: [{ label: "Checked by" }, { label: "Approved by" }],
  });
}

export async function attendanceReportExcel(requester: AuthUser, departmentId: string | undefined, from: Date, to: Date): Promise<Buffer> {
  const rows = await getDepartmentDashboard(requester, departmentId, from, to);
  return buildReportExcel({
    title: "Attendance Report",
    subtitle: `Kinbidhoo School — ${attendancePeriodLabel(from, to)}`,
    sheetName: "Attendance Report",
    columns: [
      { header: "#", key: "n", width: 5 },
      { header: "Staff ID", key: "staffCode", width: 12 },
      { header: "Name", key: "fullName", width: 24 },
      { header: "Designation", key: "designation", width: 24 },
      { header: "Days Present", key: "daysPresent", width: 12 },
      { header: "Total Hours", key: "totalHours", width: 12, money: true },
      { header: "Late", key: "lateCount", width: 8 },
      { header: "Early Leave", key: "earlyDepartureCount", width: 10 },
      { header: "Overtime Hrs", key: "overtimeHours", width: 12, money: true },
    ],
    rows: rows.map((r, i) => ({ n: i + 1, ...r })),
    totalsRow: {
      fullName: "Total",
      totalHours: Math.round(rows.reduce((s, r) => s + r.totalHours, 0) * 100) / 100,
      overtimeHours: Math.round(rows.reduce((s, r) => s + r.overtimeHours, 0) * 100) / 100,
    },
  });
}

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function payPeriodLabel(month: number, year: number): string {
  const { from, to } = payPeriodRange(month, year, env.otPeriodStartDay);
  const fmt = (d: Date) => `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
  return `${fmt(from)} to ${fmt(to)}`;
}

/**
 * Attendance Eligible List — a day-by-day matrix for the OT pay period,
 * with one "Hrs"/"Eligible" column pair per non-working day/declared
 * holiday in the period (never an ordinary working day — attendance
 * allowance eligibility only exists on those, see timesheet.ts's
 * holidayAttendanceEligible), plus two trailing per-staff summary counts.
 * Matches the legacy portal's export.
 *
 * The column set (which calendar dates get a pair) is the union of both
 * staff categories' non-working days, so every staff row shares the same
 * columns — a date that isn't actually a day off for a given staff
 * member's own category (e.g. a Teaching-only calendar entry, for a
 * Non-Teaching row) just shows "-"/"-" in their row instead of being
 * omitted from the sheet.
 */
export async function attendanceEligibleListExcel(
  requester: AuthUser,
  departmentId: string | undefined,
  month: number,
  year: number
): Promise<Buffer> {
  let deptId = departmentId;
  if (requester.role === Role.HOD) {
    deptId = requester.departmentId ?? "__none__";
  } else if (requester.role !== Role.HR_ADMIN) {
    throw new HttpError(403, "forbidden");
  }

  const { from, to } = payPeriodRange(month, year, env.otPeriodStartDay);

  const [staffList, holidayRows] = await Promise.all([
    prisma.staff.findMany({
      // Same reasoning as getDepartmentDashboard/getDailyAttendance —
      // resigned/terminated staff earned no attendance allowance this
      // period if they're gone, so they're excluded from this report.
      where: { status: "ACTIVE", ...(deptId ? { departmentId: deptId } : {}) },
      select: { id: true, fullName: true, staffId: true, designation: true, nationalIdEnc: true, category: true, staffGroup: true },
      orderBy: { staffId: "asc" },
    }),
    listHolidays(from, to),
  ]);
  const rateMap = await otRateInfoForStaffIds(staffList.map((s) => s.id));

  const teachingTypeMap = holidayTypeMapForCategory(holidayRows, "TEACHING");
  const nonTeachingTypeMap = holidayTypeMapForCategory(holidayRows, "NON_TEACHING");
  const columnDates: { key: string; label: string; isWeekend: boolean }[] = [];
  for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
    const isNonWorkingAnyCategory = resolveDayType(d, teachingTypeMap) !== null || resolveDayType(d, nonTeachingTypeMap) !== null;
    if (!isNonWorkingAnyCategory) continue;
    const dow = d.getDay();
    columnDates.push({
      key: d.toISOString().slice(0, 10),
      label: `${String(d.getDate()).padStart(2, "0")} ${MONTH_ABBR[d.getMonth()]} (${DAY_ABBR[dow]})`,
      isWeekend: dow === 5 || dow === 6,
    });
  }

  const LEAD_COLS = 5; // #, NID, Staff Name, Designation, Basic Salary
  const TRAILING_BASE = LEAD_COLS + columnDates.length * 2;
  const TOTAL_COLS = TRAILING_BASE + 2;

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Attendance Eligible List");
  sheet.columns = [
    { width: 5 },
    { width: 14 },
    { width: 22 },
    { width: 20 },
    { width: 12 },
    ...columnDates.flatMap(() => [{ width: 8 }, { width: 9 }]),
    { width: 16 },
    { width: 16 },
  ];

  function mergedRow(text: string, opts: { bold?: boolean; size?: number } = {}) {
    const row = sheet.addRow([text]);
    sheet.mergeCells(row.number, 1, row.number, TOTAL_COLS);
    row.font = { bold: opts.bold ?? true, size: opts.size ?? 11 };
    return row;
  }

  mergedRow(`Attendance Eligible List _ ${payPeriodLabel(month, year)}`, { size: 14 });
  sheet.addRow([]);

  const headerRow1Values: (string | number)[] = new Array(TOTAL_COLS).fill("");
  const headerRow2Values: (string | number)[] = new Array(TOTAL_COLS).fill("");
  headerRow2Values[0] = "#";
  headerRow2Values[1] = "NID";
  headerRow2Values[2] = "Staff Name";
  headerRow2Values[3] = "Designation";
  headerRow2Values[4] = "Basic Salary";
  columnDates.forEach((c, j) => {
    const base = LEAD_COLS + j * 2;
    headerRow1Values[base] = c.label;
    headerRow2Values[base] = "Hrs";
    headerRow2Values[base + 1] = "Eligible";
  });
  headerRow1Values[TRAILING_BASE] = "Eligible Non-Working Days";
  headerRow1Values[TRAILING_BASE + 1] = "Eligible Holidays";

  const headerRow1 = sheet.addRow(headerRow1Values);
  const headerRow2 = sheet.addRow(headerRow2Values);
  [headerRow1, headerRow2].forEach((r) => {
    r.font = { bold: true };
    r.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };
    });
  });
  for (let c = 1; c <= LEAD_COLS; c++) {
    sheet.mergeCells(headerRow1.number, c, headerRow2.number, c);
  }
  columnDates.forEach((_c, j) => {
    const col1Indexed = LEAD_COLS + j * 2 + 1;
    sheet.mergeCells(headerRow1.number, col1Indexed, headerRow1.number, col1Indexed + 1);
  });
  sheet.mergeCells(headerRow1.number, TRAILING_BASE + 1, headerRow2.number, TRAILING_BASE + 1);
  sheet.mergeCells(headerRow1.number, TRAILING_BASE + 2, headerRow2.number, TRAILING_BASE + 2);

  const rows = await Promise.all(
    staffList.map(async (s, idx) => {
      const staffTypeMap = holidayTypeMapForCategory(holidayRows, s.category);
      const entries = await prisma.timeEntry.findMany({
        where: { staffId: s.id, timestamp: { gte: from, lte: endOfUtcDay(to) } },
        orderBy: { timestamp: "asc" },
      });
      const days = buildTimesheet(entries, shiftSettingsFor(s.staffGroup), staffTypeMap);
      const dayByDate = new Map(days.map((d) => [d.date, d]));

      let eligibleNonWorking = 0;
      let eligibleHolidays = 0;
      const rowValues: (string | number)[] = new Array(TOTAL_COLS).fill("");
      rowValues[0] = idx + 1;
      rowValues[1] = decryptField(s.nationalIdEnc);
      rowValues[2] = s.fullName;
      rowValues[3] = s.designation;
      rowValues[4] = rateMap.get(s.id)?.basicSalary ?? "";

      columnDates.forEach((c, j) => {
        const base = LEAD_COLS + j * 2;
        const appliesToThisStaff = resolveDayType(new Date(c.key), staffTypeMap) !== null;
        if (!appliesToThisStaff) {
          rowValues[base] = "-";
          rowValues[base + 1] = "-";
          return;
        }
        const hoursWorked = dayByDate.get(c.key)?.hoursWorked ?? 0;
        const eligible = hoursWorked >= env.holidayAttendanceThresholdHours;
        rowValues[base] = formatHmOrDash(hoursWorked);
        rowValues[base + 1] = eligible ? "YES" : "-";
        if (eligible) {
          if (c.isWeekend) eligibleNonWorking += 1;
          else eligibleHolidays += 1;
        }
      });

      rowValues[TRAILING_BASE] = eligibleNonWorking;
      rowValues[TRAILING_BASE + 1] = eligibleHolidays;
      return rowValues;
    })
  );

  for (const rowValues of rows) sheet.addRow(rowValues);

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function importFile(actor: AuthUser, filePath: string, meta: AuditMeta = {}) {
  let succeeded = false;
  try {
    const result = await processZKTimeFile(filePath, actor.staffId);
    succeeded = true;
    await recordAudit({
      actorId: actor.staffId,
      action: "ATTENDANCE_IMPORT",
      entity: "AttendanceSyncLog",
      entityId: result.syncLogId,
      after: result,
      ...meta,
    });
    return result;
  } catch (err) {
    await recordAudit({
      actorId: actor.staffId,
      action: "ATTENDANCE_IMPORT_FAILED",
      entity: "AttendanceSyncLog",
      entityId: path.basename(filePath),
      after: { error: (err as Error).message },
      ...meta,
    });
    throw err;
  } finally {
    // Archive out of the upload folder either way, so a failed/duplicate
    // upload doesn't just sit there indefinitely.
    const archiveDir = path.join(path.dirname(filePath), succeeded ? "processed" : "failed");
    fs.mkdirSync(archiveDir, { recursive: true });
    const dest = path.join(archiveDir, `${Date.now()}-${path.basename(filePath)}`);
    if (fs.existsSync(filePath)) fs.renameSync(filePath, dest);
  }
}

export async function listSyncLogs(requester: AuthUser) {
  if (requester.role !== Role.HR_ADMIN) throw new HttpError(403, "forbidden");
  return prisma.attendanceSyncLog.findMany({ orderBy: { importedAt: "desc" }, take: 50 });
}

export async function listUnmatched(requester: AuthUser) {
  if (requester.role !== Role.HR_ADMIN) throw new HttpError(403, "forbidden");
  return prisma.attendanceUnmatchedEntry.findMany({
    where: { resolved: false },
    orderBy: { createdAt: "desc" },
    include: { syncLog: { select: { fileName: true, importedAt: true } } },
  });
}

/** Links a device user id to a staff record going forward, and retroactively
 * resolves every still-unresolved unmatched punch sharing that device id. */
export async function resolveUnmatched(actor: AuthUser, deviceUserId: string, staffId: string, meta: AuditMeta = {}) {
  if (actor.role !== Role.HR_ADMIN) throw new HttpError(403, "forbidden");

  const staff = await prisma.staff.findUnique({ where: { id: staffId } });
  if (!staff) throw new HttpError(404, "staff_not_found");

  const existingDevice = await prisma.attendanceDevice.findUnique({ where: { deviceUserId } });

  await prisma.attendanceDevice.upsert({
    where: { deviceUserId },
    create: { deviceUserId, staffId },
    update: { staffId },
  });
  await prisma.staff.update({ where: { id: staffId }, data: { deviceUserId } });

  const pending = await prisma.attendanceUnmatchedEntry.findMany({
    where: { deviceUserId, resolved: false },
  });

  for (const entry of pending) {
    await prisma.timeEntry.create({
      data: { staffId, timestamp: entry.timestamp, punchType: entry.punchType, source: "IMPORT" },
    });
    await prisma.attendanceUnmatchedEntry.update({
      where: { id: entry.id },
      data: { resolved: true, resolvedStaffId: staffId, resolvedAt: new Date() },
    });
  }

  await recordAudit({
    actorId: actor.staffId,
    action: "ATTENDANCE_UNMATCHED_RESOLVED",
    entity: "AttendanceDevice",
    entityId: deviceUserId,
    before: { previousStaffId: existingDevice?.staffId ?? null },
    after: { staffId, resolvedCount: pending.length },
    ...meta,
  });
  await notify({
    staffId,
    type: NotificationType.ATTENDANCE_DEVICE_RESOLVED,
    message: `${pending.length} historical attendance punch(es) from device "${deviceUserId}" were linked to your record.`,
  });

  return { resolvedCount: pending.length };
}

export async function submitCorrection(actor: AuthUser, input: z.infer<typeof correctionSchema>, meta: AuditMeta = {}) {
  if (input.timeEntryId) {
    const entry = await prisma.timeEntry.findUnique({ where: { id: input.timeEntryId } });
    if (!entry || entry.staffId !== actor.staffId) {
      throw new HttpError(400, "time_entry_not_owned");
    }
  }

  const request = await prisma.attendanceCorrectionRequest.create({
    data: {
      staffId: actor.staffId,
      timeEntryId: input.timeEntryId ?? null,
      date: input.date,
      requestedPunchType: input.requestedPunchType,
      requestedTime: input.requestedTime,
      reason: input.reason,
    },
  });
  await recordAudit({
    actorId: actor.staffId,
    action: "ATTENDANCE_CORRECTION_SUBMITTED",
    entity: "AttendanceCorrectionRequest",
    entityId: request.id,
    after: { date: input.date, requestedPunchType: input.requestedPunchType },
    ...meta,
  });
  await notify({
    staffId: actor.staffId,
    type: NotificationType.ATTENDANCE_CORRECTION_SUBMITTED,
    message: `Attendance correction request submitted for ${input.date.toISOString().slice(0, 10)}.`,
  });
  return request;
}

export async function listCorrections(requester: AuthUser) {
  if (requester.role === Role.HR_ADMIN) {
    return prisma.attendanceCorrectionRequest.findMany({
      where: { status: { in: ["PENDING_HOD", "PENDING_HR"] } },
      orderBy: { createdAt: "asc" },
      include: { staff: { select: { fullName: true, staffId: true, departmentId: true } } },
    });
  }
  if (requester.role === Role.HOD) {
    return prisma.attendanceCorrectionRequest.findMany({
      where: { status: "PENDING_HOD", staff: { departmentId: requester.departmentId ?? "__none__" } },
      orderBy: { createdAt: "asc" },
      include: { staff: { select: { fullName: true, staffId: true, departmentId: true } } },
    });
  }
  return prisma.attendanceCorrectionRequest.findMany({
    where: { staffId: requester.staffId },
    orderBy: { createdAt: "desc" },
  });
}

export async function reviewCorrection(
  actor: AuthUser,
  requestId: string,
  decision: "APPROVE" | "REJECT",
  meta: AuditMeta = {}
) {
  const request = await prisma.attendanceCorrectionRequest.findUnique({
    where: { id: requestId },
    include: { staff: { select: { departmentId: true } } },
  });
  if (!request) throw new HttpError(404, "not_found");

  const newStatus = nextApprovalStatus({
    current: request.status as any,
    reviewer: actor,
    requestDepartmentId: request.staff.departmentId,
    requestOwnerStaffId: request.staffId,
    decision,
  });

  const updated = await prisma.attendanceCorrectionRequest.update({
    where: { id: requestId },
    data: { status: newStatus, reviewerId: actor.staffId, reviewedAt: new Date() },
  });

  if (newStatus === "APPROVED") {
    await prisma.timeEntry.create({
      data: {
        staffId: request.staffId,
        timestamp: request.requestedTime,
        punchType: request.requestedPunchType,
        source: "MANUAL",
      },
    });
    // A corrected OVERTIME_IN/OUT punch can be exactly what completes an
    // approved OT request (or now, for the first time, falls inside its
    // window) — re-run the same check a real device import triggers so
    // this doesn't silently stay "Awaiting time clock" forever.
    if (request.requestedPunchType === PunchType.OVERTIME_IN || request.requestedPunchType === PunchType.OVERTIME_OUT) {
      await reconcileOvertimeCompletion(request.staffId, request.requestedTime);
    }
  }

  if (newStatus === "APPROVED" || newStatus === "REJECTED") {
    await recordAudit({
      actorId: actor.staffId,
      action: `ATTENDANCE_CORRECTION_${newStatus}`,
      entity: "AttendanceCorrectionRequest",
      entityId: requestId,
      ...meta,
    });
    await notify({
      staffId: request.staffId,
      type: NotificationType.ATTENDANCE_CORRECTION_REVIEWED,
      message: `Your attendance correction request was ${newStatus.toLowerCase()}.`,
    });
  }

  return updated;
}
