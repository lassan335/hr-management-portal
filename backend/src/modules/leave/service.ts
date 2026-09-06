import { AuthUser, NotificationType, Role } from "@hr/shared";
import { prisma } from "../../lib/prisma";
import { recordAudit } from "../../lib/audit";
import { notify } from "../../lib/notifications";
import { HttpError } from "../../lib/errors";
import { nextApprovalStatus } from "../../lib/approvalChain";
import type { leaveTypeSchema, termCalendarSchema, leaveRequestSchema, balanceSchema } from "./validation";
import type { z } from "zod";

type AuditMeta = { ipAddress?: string; userAgent?: string };

function inclusiveDays(start: Date, end: Date): number {
  const ms = end.setHours(0, 0, 0, 0) - new Date(start).setHours(0, 0, 0, 0);
  return Math.round(ms / 86400000) + 1;
}

export async function listLeaveTypes() {
  return prisma.leaveType.findMany({ orderBy: { name: "asc" } });
}

export async function createLeaveType(actor: AuthUser, input: z.infer<typeof leaveTypeSchema>) {
  if (actor.role !== Role.HR_ADMIN) throw new HttpError(403, "forbidden");
  return prisma.leaveType.create({ data: input });
}

export async function listTermCalendar() {
  return prisma.termCalendar.findMany({ orderBy: { startDate: "asc" } });
}

export async function createTermCalendarEntry(actor: AuthUser, input: z.infer<typeof termCalendarSchema>) {
  if (actor.role !== Role.HR_ADMIN) throw new HttpError(403, "forbidden");
  return prisma.termCalendar.create({ data: input });
}

async function findBlockingTerm(startDate: Date, endDate: Date) {
  return prisma.termCalendar.findFirst({
    where: {
      blocksLeave: true,
      startDate: { lte: endDate },
      endDate: { gte: startDate },
    },
  });
}

export async function submitLeaveRequest(
  actor: AuthUser,
  input: z.infer<typeof leaveRequestSchema>,
  meta: AuditMeta = {}
) {
  if (input.endDate < input.startDate) throw new HttpError(400, "end_before_start");

  const blockingTerm = await findBlockingTerm(input.startDate, input.endDate);
  if (blockingTerm) {
    throw new HttpError(400, `leave_blocked_by_term:${blockingTerm.termName}`);
  }

  const leaveType = await prisma.leaveType.findUnique({ where: { id: input.leaveTypeId } });
  if (!leaveType) throw new HttpError(404, "leave_type_not_found");

  const requestedDays = inclusiveDays(input.startDate, new Date(input.endDate));
  const year = input.startDate.getFullYear();

  if (leaveType.name.toLowerCase() !== "unpaid") {
    const balance = await prisma.leaveBalance.findUnique({
      where: { staffId_leaveTypeId_year: { staffId: actor.staffId, leaveTypeId: input.leaveTypeId, year } },
    });
    const available = balance ? Number(balance.balanceDays) : 0;
    if (available < requestedDays) {
      throw new HttpError(400, `insufficient_balance:available=${available},requested=${requestedDays}`);
    }
  }

  const request = await prisma.leaveRequest.create({
    data: {
      staffId: actor.staffId,
      leaveTypeId: input.leaveTypeId,
      startDate: input.startDate,
      endDate: input.endDate,
      reason: input.reason,
    },
  });

  await recordAudit({
    actorId: actor.staffId,
    action: "LEAVE_SUBMITTED",
    entity: "LeaveRequest",
    entityId: request.id,
    after: { leaveTypeId: input.leaveTypeId, startDate: input.startDate, endDate: input.endDate },
    ...meta,
  });
  await notify({
    staffId: actor.staffId,
    type: NotificationType.LEAVE_SUBMITTED,
    message: `Leave request submitted for ${input.startDate.toISOString().slice(0, 10)} to ${input.endDate.toISOString().slice(0, 10)}.`,
  });

  return request;
}

export async function listLeaveRequests(requester: AuthUser) {
  if (requester.role === Role.HR_ADMIN) {
    return prisma.leaveRequest.findMany({
      where: { status: { in: ["PENDING_HOD", "PENDING_HR"] } },
      orderBy: { createdAt: "asc" },
      include: { staff: { select: { fullName: true, staffId: true, departmentId: true } }, leaveType: true },
    });
  }
  if (requester.role === Role.HOD) {
    return prisma.leaveRequest.findMany({
      where: { status: "PENDING_HOD", staff: { departmentId: requester.departmentId ?? "__none__" } },
      orderBy: { createdAt: "asc" },
      include: { staff: { select: { fullName: true, staffId: true, departmentId: true } }, leaveType: true },
    });
  }
  return prisma.leaveRequest.findMany({
    where: { staffId: requester.staffId },
    orderBy: { createdAt: "desc" },
    include: { leaveType: true },
  });
}

export async function reviewLeaveRequest(
  actor: AuthUser,
  requestId: string,
  decision: "APPROVE" | "REJECT",
  meta: AuditMeta = {}
) {
  const request = await prisma.leaveRequest.findUnique({
    where: { id: requestId },
    include: { staff: { select: { departmentId: true } }, leaveType: true },
  });
  if (!request) throw new HttpError(404, "not_found");

  const newStatus = nextApprovalStatus({
    current: request.status as any,
    reviewer: actor,
    requestDepartmentId: request.staff.departmentId,
    decision,
  });

  const isHodStage = request.status === "PENDING_HOD";
  const updated = await prisma.leaveRequest.update({
    where: { id: requestId },
    data:
      newStatus === "PENDING_HR"
        ? { status: newStatus, hodReviewerId: actor.staffId, hodReviewedAt: new Date() }
        : isHodStage
          ? {
              status: newStatus,
              hodReviewerId: actor.staffId,
              hodReviewedAt: new Date(),
              hrReviewerId: actor.role === Role.HR_ADMIN ? actor.staffId : undefined,
              hrReviewedAt: actor.role === Role.HR_ADMIN ? new Date() : undefined,
            }
          : { status: newStatus, hrReviewerId: actor.staffId, hrReviewedAt: new Date() },
  });

  if (newStatus === "APPROVED") {
    const requestedDays = inclusiveDays(request.startDate, new Date(request.endDate));
    const year = request.startDate.getFullYear();
    if (request.leaveType.name.toLowerCase() !== "unpaid") {
      const balance = await prisma.leaveBalance.findUnique({
        where: { staffId_leaveTypeId_year: { staffId: request.staffId, leaveTypeId: request.leaveTypeId, year } },
      });
      const available = balance ? Number(balance.balanceDays) : 0;
      if (available < requestedDays) {
        // Balance changed since submission (e.g. another approved request in
        // between) — do not silently overdraw it.
        throw new HttpError(409, "insufficient_balance_at_approval");
      }
      await prisma.leaveBalance.update({
        where: { staffId_leaveTypeId_year: { staffId: request.staffId, leaveTypeId: request.leaveTypeId, year } },
        data: { balanceDays: available - requestedDays },
      });
    }
  }

  if (newStatus === "APPROVED" || newStatus === "REJECTED") {
    await recordAudit({
      actorId: actor.staffId,
      action: `LEAVE_${newStatus}`,
      entity: "LeaveRequest",
      entityId: requestId,
      ...meta,
    });
    await notify({
      staffId: request.staffId,
      type: newStatus === "APPROVED" ? NotificationType.LEAVE_APPROVED : NotificationType.LEAVE_REJECTED,
      message: `Your leave request (${request.startDate.toISOString().slice(0, 10)} – ${request.endDate.toISOString().slice(0, 10)}) was ${newStatus.toLowerCase()}.`,
    });
  }

  return updated;
}

async function assertCanViewStaffLeave(requester: AuthUser, targetStaffId: string) {
  if (targetStaffId === requester.staffId) return;
  if (requester.role === Role.HR_ADMIN) return;
  if (requester.role === Role.HOD) {
    const target = await prisma.staff.findUnique({ where: { id: targetStaffId } });
    if (target && target.departmentId === requester.departmentId) return;
  }
  throw new HttpError(403, "forbidden");
}

export async function getBalances(requester: AuthUser, targetStaffId: string) {
  await assertCanViewStaffLeave(requester, targetStaffId);
  return prisma.leaveBalance.findMany({
    where: { staffId: targetStaffId },
    include: { leaveType: true },
    orderBy: [{ year: "desc" }, { leaveType: { name: "asc" } }],
  });
}

export async function setBalance(actor: AuthUser, input: z.infer<typeof balanceSchema>) {
  if (actor.role !== Role.HR_ADMIN) throw new HttpError(403, "forbidden");
  const balance = await prisma.leaveBalance.upsert({
    where: { staffId_leaveTypeId_year: { staffId: input.staffId, leaveTypeId: input.leaveTypeId, year: input.year } },
    create: input,
    update: { balanceDays: input.balanceDays },
  });
  await recordAudit({
    actorId: actor.staffId,
    action: "LEAVE_BALANCE_SET",
    entity: "LeaveBalance",
    entityId: balance.id,
    after: input,
  });
  return balance;
}

export async function getHistory(requester: AuthUser, targetStaffId: string) {
  await assertCanViewStaffLeave(requester, targetStaffId);
  return prisma.leaveRequest.findMany({
    where: { staffId: targetStaffId },
    orderBy: { startDate: "desc" },
    include: { leaveType: true },
  });
}

/** Approved leave within a date range, for class-coverage planning. */
export async function getCalendar(requester: AuthUser, departmentId: string | undefined, from: Date, to: Date) {
  let deptId = departmentId;
  if (requester.role === Role.HOD) {
    deptId = requester.departmentId ?? "__none__";
  } else if (requester.role === Role.STAFF) {
    deptId = requester.departmentId ?? "__none__";
  }

  return prisma.leaveRequest.findMany({
    where: {
      status: "APPROVED",
      startDate: { lte: to },
      endDate: { gte: from },
      ...(deptId ? { staff: { departmentId: deptId } } : {}),
    },
    include: { staff: { select: { fullName: true, staffId: true, departmentId: true } }, leaveType: { select: { name: true } } },
    orderBy: { startDate: "asc" },
  });
}
