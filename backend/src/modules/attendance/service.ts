import fs from "fs";
import path from "path";
import { AuthUser, NotificationType, PunchType, Role } from "@hr/shared";
import { prisma } from "../../lib/prisma";
import { canAccessStaffRecord } from "../../lib/rbac";
import { recordAudit } from "../../lib/audit";
import { notify } from "../../lib/notifications";
import { HttpError } from "../../lib/errors";
import { nextApprovalStatus } from "../../lib/approvalChain";
import { endOfUtcDay } from "../../lib/dateRange";
import { buildTablePdf } from "../../lib/pdf";
import { buildReportExcel } from "../../lib/reportExcel";
import { processZKTimeFile } from "../../jobs/zktimeImport";
import { buildTimesheet, shiftSettingsFor } from "./timesheet";
import type { correctionSchema } from "./validation";
import type { z } from "zod";

type AuditMeta = { ipAddress?: string; userAgent?: string };

/** With six distinct punch types across three independent pairs (regular,
 * break, overtime), there's no single sane "toggle the last punch" guess
 * the way a plain IN/OUT clock could — the caller always says which of the
 * six they mean (see the six explicit buttons on the Attendance page). */
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
  const [staff, entries] = await Promise.all([
    prisma.staff.findUnique({ where: { id: staffId }, include: { staffGroup: true } }),
    prisma.timeEntry.findMany({
      where: { staffId, timestamp: { gte: from, lte: endOfUtcDay(to) } },
      orderBy: { timestamp: "asc" },
    }),
  ]);
  return buildTimesheet(entries, shiftSettingsFor(staff?.staffGroup ?? null));
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

  const staffList = await prisma.staff.findMany({
    where: deptId ? { departmentId: deptId } : {},
    select: { id: true, fullName: true, staffId: true, designation: true, staffGroup: true },
    orderBy: { staffId: "asc" },
  });

  const rows = await Promise.all(
    staffList.map(async (s) => {
      const entries = await prisma.timeEntry.findMany({
        where: { staffId: s.id, timestamp: { gte: from, lte: endOfUtcDay(to) } },
        orderBy: { timestamp: "asc" },
      });
      const days = buildTimesheet(entries, shiftSettingsFor(s.staffGroup));
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
