import { AuthUser, NotificationType, Role } from "@hr/shared";
import { prisma } from "../../lib/prisma";
import { recordAudit } from "../../lib/audit";
import { notify } from "../../lib/notifications";
import { HttpError } from "../../lib/errors";
import { nextApprovalStatus } from "../../lib/approvalChain";
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

export async function submitRequest(
  actor: AuthUser,
  input: z.infer<typeof overtimeRequestSchema>,
  meta: AuditMeta = {}
) {
  const request = await prisma.overtimeRequest.create({
    data: {
      staffId: actor.staffId,
      date: input.date,
      hours: input.hours,
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
    after: { date: input.date, hours: input.hours },
    ...meta,
  });
  await notify({
    staffId: actor.staffId,
    type: NotificationType.OVERTIME_SUBMITTED,
    message: `Overtime request submitted for ${input.date.toISOString().slice(0, 10)} (${input.hours}h).`,
  });
  return request;
}

export async function listRequests(requester: AuthUser) {
  if (requester.role === Role.HR_ADMIN) {
    return prisma.overtimeRequest.findMany({
      where: { status: { in: ["PENDING_HOD", "PENDING_HR"] } },
      orderBy: { createdAt: "asc" },
      include: { staff: { select: { fullName: true, staffId: true, departmentId: true } } },
    });
  }
  if (requester.role === Role.HOD) {
    return prisma.overtimeRequest.findMany({
      where: { status: "PENDING_HOD", staff: { departmentId: requester.departmentId ?? "__none__" } },
      orderBy: { createdAt: "asc" },
      include: { staff: { select: { fullName: true, staffId: true, departmentId: true } } },
    });
  }
  return prisma.overtimeRequest.findMany({
    where: { staffId: requester.staffId },
    orderBy: { createdAt: "desc" },
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

async function approvedRequestsInMonth(staffId: string, month: number, year: number) {
  const from = new Date(year, month - 1, 1);
  const to = new Date(year, month, 0, 23, 59, 59);
  return prisma.overtimeRequest.findMany({
    where: { staffId, status: "APPROVED", date: { gte: from, lte: to } },
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

  const requests = await approvedRequestsInMonth(staffId, month, year);
  let totalHours = 0;
  let totalCost = 0;
  const rows = [];
  for (const r of requests) {
    const rate = await currentRate(r.staff.departmentId, r.date);
    const rateValue = rateValueFor(rate, r.date, r.isHoliday);
    const hours = Number(r.hours);
    const cost = rateValue !== null ? hours * rateValue : null;
    totalHours += hours;
    if (cost !== null) totalCost += cost;
    rows.push({ date: r.date, hours, isHoliday: r.isHoliday, rateValue, cost });
  }
  return { staffId, month, year, totalHours: Math.round(totalHours * 100) / 100, totalCost: Math.round(totalCost * 100) / 100, rows };
}

export async function monthlySummaryCsv(requester: AuthUser, requestedStaffId: string | undefined, month: number, year: number) {
  const summary = await monthlySummary(requester, requestedStaffId, month, year);
  const header = "Date,Hours,Holiday,Rate,Cost";
  const rows = summary.rows.map((r) =>
    [r.date.toISOString().slice(0, 10), r.hours, r.isHoliday, r.rateValue ?? "", r.cost ?? ""]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(",")
  );
  return [header, ...rows, `,,,Total,${summary.totalCost}`].join("\n");
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
