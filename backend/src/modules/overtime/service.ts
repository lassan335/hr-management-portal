import { AuthUser, NotificationType, PunchType, Role } from "@hr/shared";
import { prisma } from "../../lib/prisma";
import { decryptField } from "../../lib/encryption";
import { recordAudit } from "../../lib/audit";
import { notify } from "../../lib/notifications";
import { HttpError } from "../../lib/errors";
import { nextApprovalStatus } from "../../lib/approvalChain";
import { buildTablePdf } from "../../lib/pdf";
import { buildReportExcel } from "../../lib/reportExcel";
import { payPeriodRange } from "../../lib/dateRange";
import { shiftSettingsFor } from "../attendance/timesheet";
import { env } from "../../lib/env";
import type { overtimeRequestSchema, assignOvertimeSchema, rateSchema } from "./validation";
import type { z } from "zod";

type AuditMeta = { ipAddress?: string; userAgent?: string };

async function currentRate(departmentId: string, atDate: Date) {
  return prisma.overtimeRate.findFirst({
    where: { departmentId, effectiveFrom: { lte: atDate } },
    orderBy: { effectiveFrom: "desc" },
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface OtRateInfo {
  basicSalary: number | null;
  /** Per-minute rate, not per-hour — see overtimeReport()'s doc comment for
   * the verified formula this comes from. Null when the staff member has no
   * Basic Salary configured (nothing to derive a rate from). */
  ratePerMinuteNormal: number | null;
  ratePerMinuteHoliday: number | null;
  /** Hours of "catch-up" time on a normal working day that don't count as
   * paid overtime yet — the gap between this staff member's own shift
   * length and the school's uniform OT-eligibility threshold
   * (env.overtimeEligibleThresholdHours, 8h by default). E.g. the Old
   * Framework's 6h-shift staff must still reach 8h worked before OT pay
   * starts, so the first 2h worked past their own shift end are unpaid
   * catch-up time, not overtime — a New Framework 8h-shift staff member has
   * gapHours = 0 since their shift already meets the threshold. Only
   * applies to normal-day OT: a holiday has no assigned shift to catch up
   * to, so holiday OT is never subject to this deduction. */
  gapHours: number;
}

/** Batch-fetches the Basic-Salary-derived OT rate for a set of staff —
 * shared by every place an OT amount is shown (the individual monthly
 * summary, a staff member's own request list, the HR ledger, and the
 * school-wide report) so they never silently disagree with each other. */
async function otRateInfoForStaffIds(staffIds: string[]): Promise<Map<string, OtRateInfo>> {
  const staffList = await prisma.staff.findMany({
    where: { id: { in: [...new Set(staffIds)] } },
    select: { id: true, staffGroup: true, bankDetails: { select: { basicSalaryEnc: true } } },
  });
  const map = new Map<string, OtRateInfo>();
  for (const s of staffList) {
    const basicSalary = s.bankDetails?.basicSalaryEnc ? Number(decryptField(s.bankDetails.basicSalaryEnc)) : null;
    const standardDailyHours = shiftSettingsFor(s.staffGroup).standardDailyHours;
    let ratePerMinuteNormal: number | null = null;
    let ratePerMinuteHoliday: number | null = null;
    if (basicSalary != null && standardDailyHours > 0) {
      const perMinuteBase = basicSalary / env.otRateCalendarDays / (standardDailyHours * 60);
      ratePerMinuteNormal = perMinuteBase * env.otNormalRateMultiplier;
      ratePerMinuteHoliday = perMinuteBase * env.otHolidayRateMultiplier;
    }
    const gapHours = Math.max(0, env.overtimeEligibleThresholdHours - standardDailyHours);
    map.set(s.id, { basicSalary, ratePerMinuteNormal, ratePerMinuteHoliday, gapHours });
  }
  return map;
}

/** Reduces one day's requested OT hours by whatever "catch-up" gap (see
 * OtRateInfo.gapHours) is still unconsumed for that staff member on that
 * date, so the deduction is applied once per staff+day rather than once per
 * request — a staff member with two OT slots on the same date only has the
 * gap taken out of the first one(s), not both. Callers must process a
 * batch's requests in chronological order per staff and thread the same
 * `gapRemaining` map through every call. Holiday OT is never reduced — a
 * holiday has no assigned shift to "catch up" to. */
function payableHoursFor(
  info: OtRateInfo | undefined,
  staffId: string,
  date: Date,
  hours: number,
  isHoliday: boolean,
  gapRemaining: Map<string, number>
): number {
  if (isHoliday || !info || info.gapHours <= 0) return hours;
  const key = `${staffId}|${date.toISOString().slice(0, 10)}`;
  const remaining = gapRemaining.has(key) ? gapRemaining.get(key)! : info.gapHours;
  const deduction = Math.min(remaining, hours);
  gapRemaining.set(key, round2(remaining - deduction));
  return round2(hours - deduction);
}

/** Uncapped cost for one slot (given already gap-deducted payable hours) —
 * the 10%-of-Basic-Salary self-cap only makes sense applied to a period's
 * summed normal-day cost, not a single slot, so callers showing a per-slot
 * amount (the request list, the ledger) show the true uncapped figure; only
 * the monthly/report totals are capped. */
function otCostForRequest(info: OtRateInfo | undefined, hours: number, isHoliday: boolean): number | null {
  const ratePerMinute = isHoliday ? info?.ratePerMinuteHoliday : info?.ratePerMinuteNormal;
  if (ratePerMinute == null) return null;
  return round2(hours * 60 * ratePerMinute);
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

/** Shared duration/submission-window validation for both a self-submitted
 * request and a supervisor-assigned task — same slot rules either way. */
function resolveOtSlot(input: { date: Date; timeIn: string; timeOut: string }): { timeIn: Date; timeOut: Date } {
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

  return { timeIn, timeOut };
}

export async function submitRequest(
  actor: AuthUser,
  input: z.infer<typeof overtimeRequestSchema>,
  meta: AuditMeta = {}
) {
  const { timeIn, timeOut } = resolveOtSlot(input);

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

/** A supervisor (Staff.canSupervise, or HR/Admin) creates a task directly
 * for another staff member — already pre-approved, skipping the normal
 * staff-submits/HOD-then-HR-approves chain entirely. The target staff
 * member sees it under "Tasks Assigned To Me" and marks it complete the
 * same way as any other approved slot. */
export async function assignTask(
  actor: AuthUser,
  input: z.infer<typeof assignOvertimeSchema>,
  meta: AuditMeta = {}
) {
  if (actor.role !== Role.HR_ADMIN) {
    const actorStaff = await prisma.staff.findUnique({ where: { id: actor.staffId }, select: { canSupervise: true } });
    if (!actorStaff?.canSupervise) throw new HttpError(403, "forbidden");
  }

  const target = await prisma.staff.findUnique({ where: { id: input.staffId }, select: { id: true } });
  if (!target) throw new HttpError(404, "staff_not_found");

  const { timeIn, timeOut } = resolveOtSlot(input);

  const request = await prisma.overtimeRequest.create({
    data: {
      staffId: input.staffId,
      date: input.date,
      timeIn,
      timeOut,
      reason: input.reason,
      notes: input.notes,
      isHoliday: input.isHoliday,
      status: "APPROVED",
      assignedById: actor.staffId,
    },
  });
  await recordAudit({
    actorId: actor.staffId,
    action: "OVERTIME_ASSIGNED",
    entity: "OvertimeRequest",
    entityId: request.id,
    after: { staffId: input.staffId, date: input.date, timeIn: input.timeIn, timeOut: input.timeOut },
    ...meta,
  });
  await notify({
    staffId: input.staffId,
    type: NotificationType.OVERTIME_TASK_ASSIGNED,
    message: `Overtime task assigned for ${input.date.toISOString().slice(0, 10)}, ${input.timeIn}–${input.timeOut}: ${input.reason}`,
  });
  return request;
}

export async function listRequests(requester: AuthUser) {
  let requests;
  if (requester.role === Role.HR_ADMIN) {
    requests = await prisma.overtimeRequest.findMany({
      // Pending approval, plus already-approved slots still waiting on a
      // time-clock punch (or a manual override) — HR is the only role that
      // can act on completeWork(), so this is where that queue surfaces.
      where: {
        cancelled: false,
        OR: [{ status: { in: ["PENDING_HOD", "PENDING_HR"] } }, { status: "APPROVED", workCompleted: false }],
      },
      orderBy: { createdAt: "asc" },
      include: { staff: { select: { fullName: true, staffId: true, departmentId: true } }, assignedBy: { select: { fullName: true } } },
    });
  } else if (requester.role === Role.HOD) {
    requests = await prisma.overtimeRequest.findMany({
      where: { status: "PENDING_HOD", cancelled: false, staff: { departmentId: requester.departmentId ?? "__none__" } },
      orderBy: { createdAt: "asc" },
      include: { staff: { select: { fullName: true, staffId: true, departmentId: true } }, assignedBy: { select: { fullName: true } } },
    });
  } else {
    requests = await prisma.overtimeRequest.findMany({
      where: { staffId: requester.staffId },
      orderBy: { createdAt: "desc" },
      include: {
        hodReviewer: { select: { fullName: true } },
        hrReviewer: { select: { fullName: true } },
        assignedBy: { select: { fullName: true } },
      },
    });
  }

  // Estimated amount per slot (uncapped — see otCostForRequest) so staff
  // can see roughly what a request is worth before it's even approved,
  // not just once it appears in the monthly summary. The daily catch-up gap
  // (see OtRateInfo.gapHours) must be applied in chronological order per
  // staff+day, not in whatever order these rows happen to be returned in.
  const rateMap = await otRateInfoForStaffIds(requests.map((r) => r.staffId));
  const chronological = [...requests].sort(
    (a, b) => a.staffId.localeCompare(b.staffId) || a.date.getTime() - b.date.getTime() || a.timeIn.getTime() - b.timeIn.getTime()
  );
  const gapRemaining = new Map<string, number>();
  const costById = new Map<string, number | null>();
  for (const r of chronological) {
    const info = rateMap.get(r.staffId);
    const payable = payableHoursFor(info, r.staffId, r.date, hoursBetween(r.timeIn, r.timeOut), r.isHoliday, gapRemaining);
    costById.set(r.id, otCostForRequest(info, payable, r.isHoliday));
  }

  return requests.map((r) => ({ ...r, estimatedCost: costById.get(r.id) ?? null }));
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

/** True if the staff member has at least one complete OVERTIME_IN/
 * OVERTIME_OUT punch pair that actually falls within the approved slot's
 * [timeIn, timeOut] window, per the ZKTime 5.0 biometric time clock — the
 * real-world confirmation that the pre-approved OT slot itself was worked,
 * not just that *some* overtime punches exist that day. A punch pair
 * outside the approved window (a different, unapproved stretch of time)
 * must never auto-complete a request — that would let clocking overtime at
 * any time get credited against whatever approved slot happens to share the
 * calendar date. Paired the same way buildTimesheet pairs BREAK_IN/
 * BREAK_OUT: whichever punch comes first opens the pair, the next one of
 * either type closes it; a pair only counts if the whole open-to-close span
 * sits inside the window. Only presence of a pair matters here — the *paid*
 * hours still come from the originally approved request window, not the
 * punch duration (see completeWork's doc comment for why). */
async function hasOtPunchPair(staffId: string, timeIn: Date, timeOut: Date): Promise<boolean> {
  const dayStart = new Date(timeIn);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart.getTime() + 24 * 3600000);
  const punches = await prisma.timeEntry.findMany({
    where: {
      staffId,
      timestamp: { gte: dayStart, lt: dayEnd },
      punchType: { in: [PunchType.OVERTIME_IN, PunchType.OVERTIME_OUT] },
    },
    orderBy: { timestamp: "asc" },
  });

  let openAt: Date | null = null;
  for (const p of punches) {
    if (!openAt) {
      openAt = p.timestamp;
    } else {
      if (openAt.getTime() >= timeIn.getTime() && p.timestamp.getTime() <= timeOut.getTime()) {
        return true;
      }
      openAt = null;
    }
  }
  return false;
}

async function markWorkCompleted(
  requestId: string,
  staffId: string,
  requestDate: Date,
  completionSource: "DEVICE" | "MANUAL",
  completionNote: string | null,
  actorId: string,
  meta: AuditMeta = {}
) {
  const updated = await prisma.overtimeRequest.update({
    where: { id: requestId },
    data: { workCompleted: true, workCompletedAt: new Date(), completionSource, completionNote },
  });
  await recordAudit({
    actorId,
    action: "OVERTIME_WORK_COMPLETED",
    entity: "OvertimeRequest",
    entityId: requestId,
    after: { completionSource, completionNote },
    ...meta,
  });
  await notify({
    staffId,
    type: NotificationType.OVERTIME_WORK_COMPLETED,
    message:
      completionSource === "DEVICE"
        ? `Your overtime for ${requestDate.toISOString().slice(0, 10)} was confirmed by the time clock and will be included in payroll.`
        : `Your overtime for ${requestDate.toISOString().slice(0, 10)} was marked complete by HR.`,
  });
  return updated;
}

/** Auto-completion hook, called after a ZKTime import brings in new
 * OVERTIME_IN/OVERTIME_OUT punches — checks every one of this staff
 * member's APPROVED, not-yet-completed requests on the punch's date (there
 * can be more than one) and marks Work Completed (source "DEVICE") whichever
 * ones actually have a punch pair inside their own approved window — not
 * just any OT punches that day. Returns true if at least one was completed. */
export async function reconcileOvertimeCompletion(staffId: string, date: Date): Promise<boolean> {
  const dayKey = date.toISOString().slice(0, 10);
  const candidates = await prisma.overtimeRequest.findMany({
    where: { staffId, status: "APPROVED", cancelled: false, workCompleted: false },
  });
  const sameDay = candidates.filter((r) => r.date.toISOString().slice(0, 10) === dayKey);

  let completedAny = false;
  for (const request of sameDay) {
    if (await hasOtPunchPair(staffId, request.timeIn, request.timeOut)) {
      await markWorkCompleted(request.id, staffId, request.date, "DEVICE", null, staffId);
      completedAny = true;
    }
  }
  return completedAny;
}

/**
 * Marks an approved OT request "Work Completed" — HR-only. First tries to
 * confirm it against a real OVERTIME_IN/OVERTIME_OUT punch pair from the
 * time clock (the normal path — usually already done automatically by
 * reconcileOvertimeCompletion right after the relevant ZKTime import, this
 * is the on-demand equivalent for requests approved *after* the import
 * already ran). If no device confirmation exists yet, HR can force it with
 * `manual: true` (device offline, staff forgot to punch, etc.) — recorded
 * as completionSource "MANUAL" with the given note for audit purposes.
 * Staff can no longer self-report completion — only a real punch or an
 * explicit HR override counts. Payroll totals only count requests that
 * reach this state, not merely "approved". */
export async function completeWork(
  actor: AuthUser,
  requestId: string,
  options: { manual?: boolean; note?: string } = {},
  meta: AuditMeta = {}
) {
  if (actor.role !== Role.HR_ADMIN) throw new HttpError(403, "forbidden");

  const request = await prisma.overtimeRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new HttpError(404, "not_found");
  if (request.cancelled) throw new HttpError(409, "request_cancelled");
  if (request.status !== "APPROVED") throw new HttpError(409, "not_approved");
  if (request.workCompleted) throw new HttpError(409, "already_completed");

  const deviceConfirmed = await hasOtPunchPair(request.staffId, request.timeIn, request.timeOut);
  if (!deviceConfirmed && !options.manual) {
    throw new HttpError(409, "no_device_confirmation");
  }

  return markWorkCompleted(
    request.id,
    request.staffId,
    request.date,
    deviceConfirmed ? "DEVICE" : "MANUAL",
    deviceConfirmed ? null : options.note ?? null,
    actor.staffId,
    meta
  );
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
    orderBy: [{ date: "asc" }, { timeIn: "asc" }],
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
  const rateMap = await otRateInfoForStaffIds([staffId]);
  const info = rateMap.get(staffId);

  let totalHours = 0;
  let normalCostRaw = 0;
  let holidayCost = 0;
  const gapRemaining = new Map<string, number>();
  const rows = requests.map((r) => {
    const hours = hoursBetween(r.timeIn, r.timeOut);
    totalHours += hours;
    // See OtRateInfo.gapHours — a 6h-shift staff member's first 2h past
    // their own shift end just catches them up to the school's 8h
    // eligibility threshold and isn't paid as overtime.
    const payableHours = payableHoursFor(info, staffId, r.date, hours, r.isHoliday, gapRemaining);
    const cost = otCostForRequest(info, payableHours, r.isHoliday);
    if (cost !== null) {
      if (r.isHoliday) holidayCost += cost;
      else normalCostRaw += cost;
    }
    // Displayed as an hourly-equivalent rate (rate/min * 60) so it reads
    // like the familiar MVR-per-hour figures HR is used to, even though the
    // underlying formula works in per-minute terms.
    const ratePerMinute = r.isHoliday ? info?.ratePerMinuteHoliday ?? null : info?.ratePerMinuteNormal ?? null;
    const rateValue = ratePerMinute != null ? round2(ratePerMinute * 60) : null;
    return { date: r.date, timeIn: r.timeIn, timeOut: r.timeOut, hours, isHoliday: r.isHoliday, rateValue, payableHours, cost };
  });

  // Same self-cap as overtimeReport(): normal-day OT capped at otSelfCapPercent
  // of Basic Salary; holiday OT is never capped. Applied to the aggregate,
  // not per-row, matching the source workbook's methodology.
  const basicSalary = info?.basicSalary ?? null;
  const normalCostCapped = basicSalary != null ? Math.min(normalCostRaw, basicSalary * env.otSelfCapPercent) : normalCostRaw;
  const totalCost = round2(normalCostCapped + holidayCost);

  return { staffId, month, year, totalHours: round2(totalHours), totalCost, rows };
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
 * Monthly OT Sheet — per-staff Normal/Holiday hour and cost breakdown for
 * the pay period, matching the legacy portal's school-wide overtime report.
 *
 * The rate and capping formula is verified exact against a real payroll
 * workbook's live formulas (its "Formula Deviation" and "OT CAP" sheets),
 * not reverse-engineered from output numbers:
 *   ratePerMinute(normal) = (Basic Salary / otRateCalendarDays)
 *                            / (staff's standard daily hours * 60)
 *                            * otNormalRateMultiplier
 *   ratePerMinute(holiday) = same, * otHolidayRateMultiplier instead
 * Only the current "New Pay Frame Work" formula is implemented — the
 * source workbook's deprecated Old Framework and its separate Ramazan-
 * month rate aren't (all of this school's pay periods are New Framework).
 *
 * Self Capped (Only) = normal-day OT cost capped at otSelfCapPercent of
 * Basic Salary, plus holiday OT cost (which this cap never touches) — the
 * source workbook applies this same cap unconditionally, so this report
 * does too rather than requiring HR to configure it.
 * All Capped (Final) = a school-wide budget check on top: if the sum of
 * every staff member's Self Capped amount in this report exceeds
 * otBudgetCapPercent of everyone's summed Basic Salary, each person's
 * payable amount is scaled down by the same proportion (a uniform
 * haircut) — otherwise it equals Self Capped (Only) unchanged.
 * A staff member with no Basic Salary configured shows uncapped hours
 * only — there's nothing to compute a salary-derived rate from.
 *
 * Deducted Hrs / Eligible Hrs = the daily "catch-up" gap taken out of
 * normal-day hours before it's paid (see OtRateInfo.gapHours) — a 6h-shift
 * staff member must reach 8h worked before OT pay starts, so up to 2h/day
 * of their normal-day hours are unpaid catch-up time, not overtime.
 * Eligible Hrs = Normal Hrs − Deducted Hrs, and all cost figures below are
 * already computed from Eligible Hrs (via monthlySummary's per-row cost),
 * not raw Normal Hrs.
 */
export async function overtimeReport(requester: AuthUser, departmentId: string | undefined, month: number, year: number) {
  let deptId = departmentId;
  if (requester.role === Role.HOD) {
    deptId = requester.departmentId ?? "__none__";
  } else if (requester.role !== Role.HR_ADMIN) {
    throw new HttpError(403, "forbidden");
  }

  const staffList = await prisma.staff.findMany({
    where: deptId ? { departmentId: deptId } : {},
    select: { id: true, fullName: true, staffId: true, designation: true },
    orderBy: { staffId: "asc" },
  });

  const rateMap = await otRateInfoForStaffIds(staffList.map((s) => s.id));

  const rows = await Promise.all(
    staffList.map(async (s) => {
      const summary = await monthlySummary(requester, s.id, month, year).catch(() => null);
      let normalHours = 0;
      let deductedHours = 0;
      let holidayHours = 0;
      let normalCostRaw = 0;
      let holidayCost = 0;
      for (const r of summary?.rows ?? []) {
        if (r.isHoliday) {
          holidayHours += r.hours;
          holidayCost += r.cost ?? 0;
        } else {
          normalHours += r.hours;
          deductedHours += round2(r.hours - r.payableHours);
          normalCostRaw += r.cost ?? 0;
        }
      }

      const basicSalary = rateMap.get(s.id)?.basicSalary ?? null;
      const normalCostCapped = basicSalary != null ? Math.min(normalCostRaw, basicSalary * env.otSelfCapPercent) : normalCostRaw;
      const selfCappedAmount = round2(normalCostCapped + holidayCost);

      return {
        staffId: s.id,
        staffCode: s.staffId,
        fullName: s.fullName,
        designation: s.designation,
        basicSalary,
        normalHours: round2(normalHours),
        deductedHours: round2(deductedHours),
        eligibleHours: round2(normalHours - deductedHours),
        holidayHours: round2(holidayHours),
        totalCost: round2(normalCostRaw + holidayCost),
        selfCappedAmount,
      };
    })
  );

  // School-wide budget cap: a uniform proportional haircut applied to
  // everyone when the total exceeds the budget, otherwise a no-op.
  const totalBasicSalary = rows.reduce((s, r) => s + (r.basicSalary ?? 0), 0);
  const budget = totalBasicSalary * env.otBudgetCapPercent;
  const totalSelfCapped = rows.reduce((s, r) => s + r.selfCappedAmount, 0);
  const haircut = totalSelfCapped > budget && totalSelfCapped > 0 ? budget / totalSelfCapped : 1;

  return rows.map((r) => ({ ...r, allCappedFinal: round2(r.selfCappedAmount * haircut) }));
}

function otPeriodLabel(month: number, year: number): string {
  const { from, to } = otPeriodRange(month, year);
  const fmt = (d: Date) => `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
  return `${fmt(from)} to ${fmt(to)}`;
}

export async function overtimeReportPdf(requester: AuthUser, departmentId: string | undefined, month: number, year: number): Promise<Buffer> {
  const rows = await overtimeReport(requester, departmentId, month, year);
  const totalWithoutCap = round2(rows.reduce((s, r) => s + r.totalCost, 0));
  const totalSelfCapped = round2(rows.reduce((s, r) => s + r.selfCappedAmount, 0));
  const totalAllCapped = round2(rows.reduce((s, r) => s + r.allCappedFinal, 0));
  return buildTablePdf({
    title: "Monthly OT Sheet",
    subtitle: `Kinbidhoo School — ${otPeriodLabel(month, year)}`,
    landscape: true,
    columns: [
      { header: "#", width: 25 },
      { header: "Staff ID", width: 60 },
      { header: "Name", width: 95 },
      { header: "Designation", width: 90 },
      { header: "Basic Salary", width: 65 },
      { header: "Normal Hrs", width: 55 },
      { header: "Deducted", width: 50 },
      { header: "Eligible Hrs", width: 55 },
      { header: "Holiday Hrs", width: 55 },
      { header: "OT w/o Cap", width: 65 },
      { header: "Self Capped", width: 65 },
      { header: "All Capped", width: 65 },
    ],
    rows: rows.map((r, i) => [
      i + 1,
      r.staffCode,
      r.fullName,
      r.designation,
      r.basicSalary ?? "—",
      r.normalHours,
      r.deductedHours,
      r.eligibleHours,
      r.holidayHours,
      r.totalCost,
      r.selfCappedAmount,
      r.allCappedFinal,
    ]),
    totalsRow: ["", "", "", "Total", "", "", "", "", "", totalWithoutCap, totalSelfCapped, totalAllCapped],
    signoff: [{ label: "Checked by" }, { label: "Approved by" }],
  });
}

export async function overtimeReportExcel(requester: AuthUser, departmentId: string | undefined, month: number, year: number): Promise<Buffer> {
  const rows = await overtimeReport(requester, departmentId, month, year);
  return buildReportExcel({
    title: "Monthly OT Sheet",
    subtitle: `Kinbidhoo School — ${otPeriodLabel(month, year)}`,
    sheetName: "OT Sheet",
    columns: [
      { header: "#", key: "n", width: 5 },
      { header: "Staff ID", key: "staffCode", width: 12 },
      { header: "Name", key: "fullName", width: 24 },
      { header: "Designation", key: "designation", width: 24 },
      { header: "Basic Salary", key: "basicSalary", width: 14, money: true },
      { header: "Normal Hrs", key: "normalHours", width: 12, money: true },
      { header: "Deducted Hrs", key: "deductedHours", width: 12, money: true },
      { header: "Eligible Hrs", key: "eligibleHours", width: 12, money: true },
      { header: "Holiday Hrs", key: "holidayHours", width: 12, money: true },
      { header: "OT Worked (Without Cap)", key: "totalCost", width: 20, money: true },
      { header: "Self Capped (Only)", key: "selfCappedAmount", width: 16, money: true },
      { header: "All Capped (Final)", key: "allCappedFinal", width: 16, money: true },
    ],
    rows: rows.map((r, i) => ({ n: i + 1, ...r, basicSalary: r.basicSalary ?? "" })),
    totalsRow: {
      designation: "Total",
      totalCost: round2(rows.reduce((s, r) => s + r.totalCost, 0)),
      selfCappedAmount: round2(rows.reduce((s, r) => s + r.selfCappedAmount, 0)),
      allCappedFinal: round2(rows.reduce((s, r) => s + r.allCappedFinal, 0)),
    },
  });
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

  const rateMap = await otRateInfoForStaffIds(requests.map((r) => r.staff.id));

  // Apply the daily catch-up gap (see OtRateInfo.gapHours) once per
  // staff+day, in chronological order — this listing is ordered [date,
  // staffId] for display, which doesn't guarantee same-day slots for one
  // staff member are adjacent in timeIn order.
  const chronological = [...requests].sort(
    (a, b) => a.staff.id.localeCompare(b.staff.id) || a.date.getTime() - b.date.getTime() || a.timeIn.getTime() - b.timeIn.getTime()
  );
  const gapRemaining = new Map<string, number>();
  const payableById = new Map<string, number>();
  for (const r of chronological) {
    const info = rateMap.get(r.staff.id);
    const hours = hoursBetween(r.timeIn, r.timeOut);
    payableById.set(r.id, payableHoursFor(info, r.staff.id, r.date, hours, r.isHoliday, gapRemaining));
  }

  return requests.map((r) => {
    const info = rateMap.get(r.staff.id);
    const hours = hoursBetween(r.timeIn, r.timeOut);
    const payableHours = payableById.get(r.id) ?? hours;
    const ratePerMinute = r.isHoliday ? info?.ratePerMinuteHoliday ?? null : info?.ratePerMinuteNormal ?? null;
    const rateValue = ratePerMinute != null ? round2(ratePerMinute * 60) : null;
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
      cost: otCostForRequest(info, payableHours, r.isHoliday),
    };
  });
}
