import { AuthUser, NotificationType, Role } from "@hr/shared";
import { prisma } from "../../lib/prisma";
import { recordAudit } from "../../lib/audit";
import { notify } from "../../lib/notifications";
import { HttpError } from "../../lib/errors";
import { nextApprovalStatus } from "../../lib/approvalChain";
import { buildTablePdf } from "../../lib/pdf";
import { payPeriodRange } from "../../lib/dateRange";
import { env } from "../../lib/env";
import type { overtimeRequestSchema, rateSchema } from "./validation";
import type { z } from "zod";

type AuditMeta = { ipAddress?: string; userAgent?: string };

async function currentRate(departmentId: string, atDate: Date) {
  return prisma.overtimeRate.findFirst({
    where: { departmentId, effectiveFrom: { lte: atDate } },
    orderBy: { effectiveFrom: "desc" },
  });
}

function rateValueFor(
  rate: { weekdayRate: unknown; weekendRate: unknown; holidayRate: unknown } | null,
  date: Date,
  isHoliday: boolean
): number | null {
  if (!rate) return null;
  const dayOfWeek = date.getDay();
  if (isHoliday) return Number(rate.holidayRate);
  if (dayOfWeek === 0 || dayOfWeek === 6) return Number(rate.weekendRate);
  return Number(rate.weekdayRate);
}

/** Combines a calendar date with an "HH:mm" string. If timeOut is not after
 * timeIn, the slot is assumed to cross midnight (e.g. 22:00 -> 02:00). */
function combineDateAndTime(date: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d;
}

function hoursBetween(timeIn: Date, timeOut: Date): number {
  const ms = timeOut.getTime() - timeIn.getTime();
  return Math.round((ms / 3600000) * 100) / 100;
}

export async function submitRequest(
  actor: AuthUser,
  input: z.infer<typeof overtimeRequestSchema>,
  meta: AuditMeta = {}
) {
  const timeIn = combineDateAndTime(input.date, input.timeIn);
  let timeOut = combineDateAndTime(input.date, input.timeOut);
  if (timeOut <= timeIn) timeOut = new Date(timeOut.getTime() + 24 * 3600000); // crosses midnight

  const durationMinutes = (timeOut.getTime() - timeIn.getTime()) / 60000;
  if (durationMinutes > env.otMaxContinuousMinutes) {
    throw new HttpError(400, `duration_exceeds_max:${env.otMaxContinuousMinutes}min`);
  }

  const daysSinceDate = (Date.now() - input.date.getTime()) / 86400000;
  if (daysSinceDate > env.otSubmissionWindowDays) {
    throw new HttpError(400, `submission_window_expired:${env.otSubmissionWindowDays}days`);
  }

  const request = await prisma.overtimeRequest.create({
    data: {
      staffId: actor.staffId,
      date: input.date,
      timeIn,
      timeOut,
      reason: input.reason,
      notes: input.notes,
      isHoliday: input.isHoliday,
    },
  });
  await recordAudit({
    actorId: actor.staffId,
    action: "OVERTIME_SUBMITTED",
    entity: "OvertimeRequest",
    entityId: request.id,
    after: { date: input.date, timeIn: input.timeIn, timeOut: input.timeOut },
    ...meta,
  });
  await notify({
    staffId: actor.staffId,
    type: NotificationType.OVERTIME_SUBMITTED,
    message: `Overtime request submitted for ${input.date.toISOString().slice(0, 10)}, ${input.timeIn}–${input.timeOut}.`,
  });
  return request;
}

export async function listRequests(requester: AuthUser) {
  if (requester.role === Role.HR_ADMIN) {
    return prisma.overtimeRequest.findMany({
      where: { status: { in: ["PENDING_HOD", "PENDING_HR"] }, cancelled: false },
      orderBy: { createdAt: "asc" },
      include: { staff: { select: { fullName: true, staffId: true, departmentId: true } } },
    });
  }
  if (requester.role === Role.HOD) {
    return prisma.overtimeRequest.findMany({
      where: { status: "PENDING_HOD", cancelled: false, staff: { departmentId: requester.departmentId ?? "__none__" } },
      orderBy: { createdAt: "asc" },
      include: { staff: { select: { fullName: true, staffId: true, departmentId: true } } },
    });
  }
  return prisma.overtimeRequest.findMany({
    where: { staffId: requester.staffId },
    orderBy: { createdAt: "desc" },
    include: { hodReviewer: { select: { fullName: true } }, hrReviewer: { select: { fullName: true } } },
  });
}

export async function reviewRequest(
  actor: AuthUser,
  requestId: string,
  decision: "APPROVE" | "REJECT",
  meta: AuditMeta = {}
) {
  const request = await prisma.overtimeRequest.findUnique({
    where: { id: requestId },
    include: { staff: { select: { departmentId: true } } },
  });
  if (!request) throw new HttpError(404, "not_found");
  if (request.cancelled) throw new HttpError(409, "request_cancelled");

  const newStatus = nextApprovalStatus({
    current: request.status as any,
    reviewer: actor,
    requestDepartmentId: request.staff.departmentId,
    requestOwnerStaffId: request.staffId,
    decision,
  });

  const isHodStage = request.status === "PENDING_HOD";
  const updated = await prisma.overtimeRequest.update({
    where: { id: requestId },
    data:
      newStatus === "PENDING_HR"
        ? { status: newStatus, hodReviewerId: actor.staffId, hodReviewedAt: new Date() }
        : isHodStage
          ? { status: newStatus, hodReviewerId: actor.staffId, hodReviewedAt: new Date(), hrReviewerId: actor.role === Role.HR_ADMIN ? actor.staffId : undefined, hrReviewedAt: actor.role === Role.HR_ADMIN ? new Date() : undefined }
          : { status: newStatus, hrReviewerId: actor.staffId, hrReviewedAt: new Date() },
  });

  if (newStatus === "APPROVED" || newStatus === "REJECTED") {
    await recordAudit({
      actorId: actor.staffId,
      action: `OVERTIME_${newStatus}`,
      entity: "OvertimeRequest",
      entityId: requestId,
      ...meta,
    });
    await notify({
      staffId: request.staffId,
      type: newStatus === "APPROVED" ? NotificationType.OVERTIME_APPROVED : NotificationType.OVERTIME_REJECTED,
      message: `Your overtime request for ${request.date.toISOString().slice(0, 10)} was ${newStatus.toLowerCase()}.`,
    });
  }

  return updated;
}

/** Staff withdrawing their own request — allowed any time before the work is
 * marked completed, regardless of approval stage (plans changed). */
export async function cancelRequest(actor: AuthUser, requestId: string, meta: AuditMeta = {}) {
  const request = await prisma.overtimeRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new HttpError(404, "not_found");
  if (request.staffId !== actor.staffId) throw new HttpError(403, "forbidden");
  if (request.cancelled) throw new HttpError(409, "already_cancelled");
  if (request.workCompleted) throw new HttpError(409, "already_completed");

  const updated = await prisma.overtimeRequest.update({
    where: { id: requestId },
    data: { cancelled: true, cancelledAt: new Date() },
  });
  await recordAudit({
    actorId: actor.staffId,
    action: "OVERTIME_CANCELLED",
    entity: "OvertimeRequest",
    entityId: requestId,
    ...meta,
  });
  return updated;
}

/** Staff confirming the approved work actually happened — only APPROVED,
 * non-cancelled requests can be marked complete. Payroll totals below only
 * count requests that reach this state, not merely "approved". */
export async function completeWork(actor: AuthUser, requestId: string, meta: AuditMeta = {}) {
  const request = await prisma.overtimeRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new HttpError(404, "not_found");
  if (request.staffId !== actor.staffId) throw new HttpError(403, "forbidden");
  if (request.cancelled) throw new HttpError(409, "request_cancelled");
  if (request.status !== "APPROVED") throw new HttpError(409, "not_approved");
  if (request.workCompleted) throw new HttpError(409, "already_completed");

  const updated = await prisma.overtimeRequest.update({
    where: { id: requestId },
    data: { workCompleted: true, workCompletedAt: new Date() },
  });
  await recordAudit({
    actorId: actor.staffId,
    action: "OVERTIME_WORK_COMPLETED",
    entity: "OvertimeRequest",
    entityId: requestId,
    ...meta,
  });
  return updated;
}

export async function setRate(actor: AuthUser, input: z.infer<typeof rateSchema>, meta: AuditMeta = {}) {
  if (actor.role !== Role.HR_ADMIN) throw new HttpError(403, "forbidden");
  const rate = await prisma.overtimeRate.create({
    data: {
      departmentId: input.departmentId,
      weekdayRate: input.weekdayRate,
      weekendRate: input.weekendRate,
      holidayRate: input.holidayRate,
    },
  });
  await recordAudit({
    actorId: actor.staffId,
    action: "OVERTIME_RATE_SET",
    entity: "OvertimeRate",
    entityId: rate.id,
    after: input,
    ...meta,
  });
  return rate;
}

export async function getCurrentRate(requester: AuthUser, departmentId: string) {
  if (requester.role !== Role.HR_ADMIN && requester.departmentId !== departmentId) {
    throw new HttpError(403, "forbidden");
  }
  return currentRate(departmentId, new Date());
}

/** Only requests that were approved AND actually completed AND never
 * cancelled count toward payroll — an approved-but-never-done slot isn't paid. */
function otPeriodRange(month: number, year: number): { from: Date; to: Date } {
  return payPeriodRange(month, year, env.otPeriodStartDay);
}

async function payableRequestsInMonth(staffId: string, month: number, year: number) {
  const { from, to } = otPeriodRange(month, year);
  return prisma.overtimeRequest.findMany({
    where: { staffId, status: "APPROVED", workCompleted: true, cancelled: false, date: { gte: from, lte: to } },
    orderBy: { date: "asc" },
    include: { staff: { select: { departmentId: true } } },
  });
}

export async function monthlySummary(requester: AuthUser, requestedStaffId: string | undefined, month: number, year: number) {
  const staffId = requestedStaffId && requestedStaffId !== requester.staffId ? requestedStaffId : requester.staffId;
  if (staffId !== requester.staffId) {
    const target = await prisma.staff.findUnique({ where: { id: staffId } });
    if (!target) throw new HttpError(404, "not_found");
    const allowed = requester.role === Role.HR_ADMIN || (requester.role === Role.HOD && requester.departmentId === target.departmentId);
    if (!allowed) throw new HttpError(403, "forbidden");
  }

  const requests = await payableRequestsInMonth(staffId, month, year);
  let totalHours = 0;
  let totalCost = 0;
  const rows = [];
  for (const r of requests) {
    const rate = await currentRate(r.staff.departmentId, r.date);
    const rateValue = rateValueFor(rate, r.date, r.isHoliday);
    const hours = hoursBetween(r.timeIn, r.timeOut);
    const cost = rateValue !== null ? hours * rateValue : null;
    totalHours += hours;
    if (cost !== null) totalCost += cost;
    rows.push({ date: r.date, timeIn: r.timeIn, timeOut: r.timeOut, hours, isHoliday: r.isHoliday, rateValue, cost });
  }
  return { staffId, month, year, totalHours: Math.round(totalHours * 100) / 100, totalCost: Math.round(totalCost * 100) / 100, rows };
}

export async function monthlySummaryCsv(requester: AuthUser, requestedStaffId: string | undefined, month: number, year: number) {
  const summary = await monthlySummary(requester, requestedStaffId, month, year);
  const header = "Date,Time In,Time Out,Hours,Holiday,Rate,Cost";
  const rows = summary.rows.map((r) =>
    [
      r.date.toISOString().slice(0, 10),
      r.timeIn.toLocaleTimeString(),
      r.timeOut.toLocaleTimeString(),
      r.hours,
      r.isHoliday,
      r.rateValue ?? "",
      r.cost ?? "",
    ]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(",")
  );
  return [header, ...rows, `,,,,,Total,${summary.totalCost}`].join("\n");
}

export async function monthlySummaryPdf(
  requester: AuthUser,
  requestedStaffId: string | undefined,
  month: number,
  year: number
): Promise<Buffer> {
  const summary = await monthlySummary(requester, requestedStaffId, month, year);
  const staff = await prisma.staff.findUnique({ where: { id: summary.staffId }, select: { fullName: true, staffId: true } });

  return buildTablePdf({
    title: "Overtime Summary",
    subtitle: `${staff?.fullName ?? summary.staffId} (${staff?.staffId ?? ""}) — ${summary.month}/${summary.year} (completed work only)`,
    columns: [
      { header: "Date", width: 80 },
      { header: "Time In", width: 70 },
      { header: "Time Out", width: 70 },
      { header: "Hours", width: 50 },
      { header: "Holiday", width: 60 },
      { header: "Rate", width: 70 },
      { header: "Cost", width: 70 },
    ],
    rows: summary.rows.map((r) => [
      r.date.toISOString().slice(0, 10),
      r.timeIn.toLocaleTimeString(),
      r.timeOut.toLocaleTimeString(),
      r.hours,
      r.isHoliday ? "Yes" : "No",
      r.rateValue ?? "n/a",
      r.cost ?? "n/a",
    ]),
    totalsRow: ["Total", "", "", summary.totalHours, "", "", summary.totalCost],
  });
}

export async function departmentDashboard(requester: AuthUser, departmentId: string | undefined, month: number, year: number) {
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
      const summary = await monthlySummary(requester, s.id, month, year).catch(() => null);
      return {
        staffId: s.id,
        staffCode: s.staffId,
        fullName: s.fullName,
        totalHours: summary?.totalHours ?? 0,
        totalCost: summary?.totalCost ?? 0,
      };
    })
  );
  return rows;
}

/**
 * Flat, individual-entry ledger across all (or one department's) staff for
 * an OT period — matches the legacy portal's "View and Manage Monthly OT
 * Sheets" screen (one row per completed slot, not per-staff totals).
 * HR/Admin or a HOD (scoped to their own department) only.
 *
 * Deliberately NOT implemented here, matching fields visible in that legacy
 * screen but out of scope for now: numeric Basic Salary / Self-Capped /
 * Group-Capped columns (this schema has no plain numeric salary field to
 * cap against — salaryGrade is free text, encrypted), "Attendance Eligible"
 * cross-checked against ZKTime punches, and a manual "Verified" QA flag.
 */
export async function ledger(requester: AuthUser, departmentId: string | undefined, month: number, year: number) {
  let deptId = departmentId;
  if (requester.role === Role.HOD) {
    deptId = requester.departmentId ?? "__none__";
  } else if (requester.role !== Role.HR_ADMIN) {
    throw new HttpError(403, "forbidden");
  }

  const { from, to } = otPeriodRange(month, year);
  const requests = await prisma.overtimeRequest.findMany({
    where: {
      status: "APPROVED",
      workCompleted: true,
      cancelled: false,
      date: { gte: from, lte: to },
      ...(deptId ? { staff: { departmentId: deptId } } : {}),
    },
    orderBy: [{ date: "asc" }, { staffId: "asc" }],
    include: { staff: { select: { id: true, staffId: true, fullName: true, departmentId: true } } },
  });

  return Promise.all(
    requests.map(async (r) => {
      const rate = await currentRate(r.staff.departmentId, r.date);
      const rateValue = rateValueFor(rate, r.date, r.isHoliday);
      const hours = hoursBetween(r.timeIn, r.timeOut);
      return {
        staffId: r.staff.id,
        staffCode: r.staff.staffId,
        fullName: r.staff.fullName,
        date: r.date,
        timeIn: r.timeIn,
        timeOut: r.timeOut,
        hours,
        isHoliday: r.isHoliday,
        description: r.reason,
        rateValue,
        cost: rateValue !== null ? hours * rateValue : null,
      };
    })
  );
}
