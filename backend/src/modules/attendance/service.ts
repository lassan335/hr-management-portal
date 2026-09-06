import fs from "fs";
import path from "path";
import { AuthUser, NotificationType, PunchType, Role } from "@hr/shared";
import { prisma } from "../../lib/prisma";
import { canAccessStaffRecord } from "../../lib/rbac";
import { recordAudit } from "../../lib/audit";
import { notify } from "../../lib/notifications";
import { HttpError } from "../../lib/errors";
import { nextApprovalStatus } from "../../lib/approvalChain";
import { processZKTimeFile } from "../../jobs/zktimeImport";
import { buildTimesheet } from "./timesheet";
import type { correctionSchema } from "./validation";
import type { z } from "zod";

export async function clockPunch(actor: AuthUser, override?: PunchType) {
  let punchType = override;
  if (!punchType) {
    const last = await prisma.timeEntry.findFirst({
      where: { staffId: actor.staffId },
      orderBy: { timestamp: "desc" },
    });
    punchType = !last || last.punchType === PunchType.OUT ? PunchType.IN : PunchType.OUT;
  }
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
  const entries = await prisma.timeEntry.findMany({
    where: { staffId, timestamp: { gte: from, lte: to } },
    orderBy: { timestamp: "asc" },
  });
  return buildTimesheet(entries);
}

export async function exportTimesheetCsv(requester: AuthUser, requestedStaffId: string | undefined, from: Date, to: Date) {
  const days = await getTimesheet(requester, requestedStaffId, from, to);
  const header = "Date,First In,Last Out,Hours Worked,Late Arrival,Early Departure,Overtime Hours";
  const rows = days.map((d) =>
    [d.date, d.firstIn ?? "", d.lastOut ?? "", d.hoursWorked, d.lateArrival, d.earlyDeparture, d.overtimeHours]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(",")
  );
  return [header, ...rows].join("\n");
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
    select: { id: true, fullName: true, staffId: true },
  });

  const rows = await Promise.all(
    staffList.map(async (s) => {
      const entries = await prisma.timeEntry.findMany({
        where: { staffId: s.id, timestamp: { gte: from, lte: to } },
        orderBy: { timestamp: "asc" },
      });
      const days = buildTimesheet(entries);
      return {
        staffId: s.id,
        staffCode: s.staffId,
        fullName: s.fullName,
        totalHours: Math.round(days.reduce((sum, d) => sum + d.hoursWorked, 0) * 100) / 100,
        lateCount: days.filter((d) => d.lateArrival).length,
        earlyDepartureCount: days.filter((d) => d.earlyDeparture).length,
        overtimeHours: Math.round(days.reduce((sum, d) => sum + d.overtimeHours, 0) * 100) / 100,
      };
    })
  );

  return rows;
}

export async function importFile(actor: AuthUser, filePath: string) {
  const result = await processZKTimeFile(filePath, actor.staffId);
  await recordAudit({
    actorId: actor.staffId,
    action: "ATTENDANCE_IMPORT",
    entity: "AttendanceSyncLog",
    entityId: result.syncLogId,
    after: result,
  });

  // Move the uploaded file out of the incoming/ drop folder so the watcher
  // (which also monitors that folder) never re-processes it.
  const processedDir = path.join(path.dirname(filePath), "processed");
  fs.mkdirSync(processedDir, { recursive: true });
  const dest = path.join(processedDir, `${Date.now()}-${path.basename(filePath)}`);
  if (fs.existsSync(filePath)) fs.renameSync(filePath, dest);

  return result;
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
export async function resolveUnmatched(actor: AuthUser, deviceUserId: string, staffId: string) {
  if (actor.role !== Role.HR_ADMIN) throw new HttpError(403, "forbidden");

  const staff = await prisma.staff.findUnique({ where: { id: staffId } });
  if (!staff) throw new HttpError(404, "staff_not_found");

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
    after: { staffId, resolvedCount: pending.length },
  });

  return { resolvedCount: pending.length };
}

export async function submitCorrection(actor: AuthUser, input: z.infer<typeof correctionSchema>) {
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

export async function reviewCorrection(actor: AuthUser, requestId: string, decision: "APPROVE" | "REJECT") {
  const request = await prisma.attendanceCorrectionRequest.findUnique({
    where: { id: requestId },
    include: { staff: { select: { departmentId: true } } },
  });
  if (!request) throw new HttpError(404, "not_found");

  const newStatus = nextApprovalStatus({
    current: request.status as any,
    reviewer: actor,
    requestDepartmentId: request.staff.departmentId,
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
    });
    await notify({
      staffId: request.staffId,
      type: NotificationType.ATTENDANCE_CORRECTION_REVIEWED,
      message: `Your attendance correction request was ${newStatus.toLowerCase()}.`,
    });
  }

  return updated;
}
