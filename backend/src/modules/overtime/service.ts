import ExcelJS from "exceljs";
import { AuthUser, NotificationType, Role } from "@hr/shared";
import { prisma } from "../../lib/prisma";
import { decryptField } from "../../lib/encryption";
import { recordAudit } from "../../lib/audit";
import { notify } from "../../lib/notifications";
import { HttpError } from "../../lib/errors";
import { nextApprovalStatus } from "../../lib/approvalChain";
import { buildTablePdf } from "../../lib/pdf";
import { buildReportExcel } from "../../lib/reportExcel";
import { payPeriodRange } from "../../lib/dateRange";
import { formatHm } from "../../lib/hoursFormat";
import { shiftSettingsFor } from "../attendance/timesheet";
import { isPublicHolidayDate } from "../holidays/service";
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
export async function otRateInfoForStaffIds(staffIds: string[]): Promise<Map<string, OtRateInfo>> {
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

/** Staff eligible to be picked as a request's reviewer — Staff.canSupervise,
 * or HR_ADMIN. Shared by submitRequest's validation and the /supervisors
 * listing endpoint so they never drift apart. */
async function isEligibleSupervisor(staffId: string): Promise<boolean> {
  const staff = await prisma.staff.findUnique({ where: { id: staffId }, select: { canSupervise: true, role: true } });
  return !!staff && (staff.canSupervise || staff.role === Role.HR_ADMIN);
}

/** Any authenticated staff member can call this — picking a reviewer at
 * submission time is a self-service step, not something gated behind
 * canSupervise/HOD/HR_ADMIN like the full staff directory (listStaff). */
export async function listSupervisors(actor: AuthUser) {
  const staff = await prisma.staff.findMany({
    where: { status: "ACTIVE", OR: [{ canSupervise: true }, { role: Role.HR_ADMIN }], id: { not: actor.staffId } },
    select: { id: true, fullName: true, staffId: true, designation: true },
    orderBy: { fullName: "asc" },
  });
  return staff;
}

export async function submitRequest(
  actor: AuthUser,
  input: z.infer<typeof overtimeRequestSchema>,
  meta: AuditMeta = {}
) {
  const { timeIn, timeOut } = resolveOtSlot(input);

  if (input.supervisorId === actor.staffId) throw new HttpError(400, "cannot_select_self");
  if (!(await isEligibleSupervisor(input.supervisorId))) throw new HttpError(400, "invalid_supervisor");

  // Derived from the real calendar, not the client's checkbox — the OT rate
  // (elevated for a Public Holiday, same as normal for Government/weekday)
  // depends on this being right, so it isn't left to manual entry. See
  // holidays/service.ts's resolveDayType for what "Public" means here.
  const actorStaff = await prisma.staff.findUnique({ where: { id: actor.staffId }, select: { category: true } });
  const isHoliday = await isPublicHolidayDate(input.date, actorStaff?.category ?? "NON_TEACHING");

  const request = await prisma.overtimeRequest.create({
    data: {
      staffId: actor.staffId,
      date: input.date,
      timeIn,
      timeOut,
      reason: input.reason,
      notes: input.notes,
      isHoliday,
      selectedSupervisorId: input.supervisorId,
    },
  });
  await recordAudit({
    actorId: actor.staffId,
    action: "OVERTIME_SUBMITTED",
    entity: "OvertimeRequest",
    entityId: request.id,
    after: { date: input.date, timeIn: input.timeIn, timeOut: input.timeOut, supervisorId: input.supervisorId },
    ...meta,
  });
  await notify({
    staffId: actor.staffId,
    type: NotificationType.OVERTIME_SUBMITTED,
    message: `Overtime request submitted for ${input.date.toISOString().slice(0, 10)}, ${input.timeIn}–${input.timeOut}.`,
  });
  await notify({
    staffId: input.supervisorId,
    type: NotificationType.OVERTIME_SUBMITTED,
    message: `${actor.fullName} submitted an overtime request for ${input.date.toISOString().slice(0, 10)}, ${input.timeIn}–${input.timeOut}, for your review.`,
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

  const target = await prisma.staff.findUnique({ where: { id: input.staffId }, select: { id: true, category: true } });
  if (!target) throw new HttpError(404, "staff_not_found");

  const { timeIn, timeOut } = resolveOtSlot(input);
  // See submitRequest's comment — derived from the real calendar, not a
  // client-supplied flag, using the target staff member's own category.
  const isHoliday = await isPublicHolidayDate(input.date, target.category);

  const request = await prisma.overtimeRequest.create({
    data: {
      staffId: input.staffId,
      date: input.date,
      timeIn,
      timeOut,
      reason: input.reason,
      notes: input.notes,
      isHoliday,
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
  } else {
    // Everyone else — including a HOD, and a plain-role-STAFF supervisor
    // (most real supervisors carry plain STAFF, see Staff.canSupervise) —
    // sees their own submitted requests, plus anything actually pending
    // THEIR review: either a staff member specifically picked them as
    // reviewer (see submitRequest/listSupervisors), or (HOD only, legacy
    // requests submitted before that existed) it's in their department.
    requests = await prisma.overtimeRequest.findMany({
      where: {
        cancelled: false,
        OR: [
          { staffId: requester.staffId },
          { status: "PENDING_HOD", selectedSupervisorId: requester.staffId },
          ...(requester.role === Role.HOD
            ? [{ status: "PENDING_HOD" as const, selectedSupervisorId: null, staff: { departmentId: requester.departmentId ?? "__none__" } }]
            : []),
        ],
      },
      orderBy: { createdAt: "desc" },
      include: {
        staff: { select: { fullName: true, staffId: true, departmentId: true } },
        hodReviewer: { select: { fullName: true } },
        hrReviewer: { select: { fullName: true } },
        assignedBy: { select: { fullName: true } },
        selectedSupervisor: { select: { fullName: true } },
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

  let newStatus: "PENDING_HOD" | "PENDING_HR" | "APPROVED" | "REJECTED";
  let updateData: Record<string, unknown>;

  if (request.selectedSupervisorId) {
    // Single-stage: only the supervisor the staff member picked at
    // submission (or HR_ADMIN, as a fallback) may decide — see
    // submitRequest/listSupervisors. Approval goes straight to APPROVED,
    // no separate HOD-then-HR chain.
    if (actor.staffId === request.staffId) throw new HttpError(403, "cannot_review_own_request");
    const canReview = actor.staffId === request.selectedSupervisorId || actor.role === Role.HR_ADMIN;
    if (!canReview) throw new HttpError(403, "forbidden");
    if (request.status !== "PENDING_HOD") throw new HttpError(409, "already_reviewed");

    newStatus = decision === "APPROVE" ? "APPROVED" : "REJECTED";
    updateData = { status: newStatus, hodReviewerId: actor.staffId, hodReviewedAt: new Date() };
  } else {
    // Legacy requests submitted before supervisor selection existed — keep
    // the old department HOD -> HR chain so nothing already in flight gets stranded.
    newStatus = nextApprovalStatus({
      current: request.status as any,
      reviewer: actor,
      requestDepartmentId: request.staff.departmentId,
      requestOwnerStaffId: request.staffId,
      decision,
    });

    const isHodStage = request.status === "PENDING_HOD";
    updateData =
      newStatus === "PENDING_HR"
        ? { status: newStatus, hodReviewerId: actor.staffId, hodReviewedAt: new Date() }
        : isHodStage
          ? { status: newStatus, hodReviewerId: actor.staffId, hodReviewedAt: new Date(), hrReviewerId: actor.role === Role.HR_ADMIN ? actor.staffId : undefined, hrReviewedAt: actor.role === Role.HR_ADMIN ? new Date() : undefined }
          : { status: newStatus, hrReviewerId: actor.staffId, hrReviewedAt: new Date() };
  }

  const updated = await prisma.overtimeRequest.update({ where: { id: requestId }, data: updateData });

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

/** True if there are at least two real time-clock punches — of ANY type —
 * with timestamps both inside the approved slot's [timeIn, timeOut] window.
 * That's the real-world confirmation that the pre-approved OT slot was
 * actually worked.
 *
 * This deliberately does NOT filter by punchType. There's one physical
 * biometric device and it has no "this is an OT punch" button — confirmed
 * by reading its raw wire protocol directly, it reports nothing but a
 * timestamp and user ID. Our own sync job infers CHECK_IN/CHECK_OUT/
 * BREAK_IN/BREAK_OUT purely from position within that calendar day's whole
 * punch sequence (see zktimeDevicePoll.ts), so an evening OT session's
 * punches can land with any of those labels depending on how many other
 * sessions happened earlier that day — they will never come back labeled
 * OVERTIME_IN/OVERTIME_OUT. Filtering on that type here would mean no real
 * device punch could ever auto-complete an approved request, only a manual
 * HR override or a hand-typed correction ever could.
 *
 * A punch pair outside the approved window (a different, unapproved
 * stretch of time) must never auto-complete a request — that would let
 * clocking in at any time get credited against whatever approved slot
 * happens to share the calendar date. Only presence of 2+ punches matters
 * here — the *paid* hours still come from the originally approved request
 * window, not the punch duration (see completeWork's doc comment for why). */
/** Confirms an approved OT slot against real punches — 2+ within the
 * window — and relabels the first/last of them OVERTIME_IN/OVERTIME_OUT so
 * the timesheet's OT columns show it, not just an invisible backend match.
 *
 * The relabel is skipped for a punch that's also serving as the day's
 * actual CHECK_IN/CHECK_OUT (common when an approved OT slot is someone's
 * only activity that day — most OT is a standalone weekend/holiday
 * session). buildTimesheet finds firstIn/lastOut by scanning specifically
 * for those two types, so relabeling one away would zero out that day's
 * hoursWorked. The slot is still confirmed either way (payroll only cares
 * about workCompleted) — relabeling only happens when it's free, i.e. an OT
 * session sandwiched onto a regular work day, where the matched punches are
 * currently BREAK_IN/BREAK_OUT (safe to retype either direction). */
async function confirmAndLabelOtPunches(staffId: string, timeIn: Date, timeOut: Date): Promise<boolean> {
  const punches = await prisma.timeEntry.findMany({
    where: { staffId, timestamp: { gte: timeIn, lte: timeOut } },
    orderBy: { timestamp: "asc" },
    select: { id: true, punchType: true },
  });
  if (punches.length < 2) return false;

  const isBoundaryType = (t: string) => t === "CHECK_IN" || t === "CHECK_OUT";
  const first = punches[0];
  const last = punches[punches.length - 1];
  if (!isBoundaryType(first.punchType)) {
    await prisma.timeEntry.update({ where: { id: first.id }, data: { punchType: "OVERTIME_IN" } });
  }
  if (!isBoundaryType(last.punchType)) {
    await prisma.timeEntry.update({ where: { id: last.id }, data: { punchType: "OVERTIME_OUT" } });
  }
  return true;
}

async function markWorkCompleted(
  requestId: string,
  staffId: string,
  requestDate: Date,
  completionSource: "STAFF_REPORTED" | "DEVICE" | "MANUAL",
  completionNote: string | null,
  actorId: string,
  meta: AuditMeta = {},
  times?: { timeIn: Date; timeOut: Date }
) {
  const updated = await prisma.overtimeRequest.update({
    where: { id: requestId },
    data: {
      workCompleted: true,
      workCompletedAt: new Date(),
      completionSource,
      completionNote,
      ...(times ? { timeIn: times.timeIn, timeOut: times.timeOut } : {}),
    },
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
      completionSource === "STAFF_REPORTED"
        ? `Your overtime for ${requestDate.toISOString().slice(0, 10)} was recorded and will be included in payroll.`
        : completionSource === "DEVICE"
          ? `Your overtime for ${requestDate.toISOString().slice(0, 10)} was confirmed by the time clock and will be included in payroll.`
          : `Your overtime for ${requestDate.toISOString().slice(0, 10)} was marked complete by HR.`,
  });
  return updated;
}

/**
 * The normal completion path: once a request is APPROVED, the staff member
 * who owns it reports the actual time they worked (they can see their own
 * real attendance on the Attendance page to get this right) — replaces
 * waiting on a device-punch match, whose Break/OT classification is only
 * validated to ~86% accuracy (see zktimeDevicePoll.ts). Overwrites the
 * request's original (requested/estimated) timeIn/timeOut with the actual
 * worked time, since that's what payroll (monthlySummary, overtimeReport)
 * reads. Duration is still capped at otMaxContinuousMinutes, same as at
 * submission — but NOT re-checked against the submission window, since
 * completion can legitimately happen days after the original request date.
 */
export async function reportOvertimeCompletion(
  actor: AuthUser,
  requestId: string,
  input: { timeIn: string; timeOut: string },
  meta: AuditMeta = {}
) {
  const request = await prisma.overtimeRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new HttpError(404, "not_found");
  if (request.staffId !== actor.staffId) throw new HttpError(403, "forbidden");
  if (request.cancelled) throw new HttpError(409, "request_cancelled");
  if (request.status !== "APPROVED") throw new HttpError(409, "not_approved");
  if (request.workCompleted) throw new HttpError(409, "already_completed");

  const timeIn = combineDateAndTime(request.date, input.timeIn);
  let timeOut = combineDateAndTime(request.date, input.timeOut);
  if (timeOut <= timeIn) timeOut = new Date(timeOut.getTime() + 24 * 3600000); // crosses midnight
  const durationMinutes = (timeOut.getTime() - timeIn.getTime()) / 60000;
  if (durationMinutes > env.otMaxContinuousMinutes) {
    throw new HttpError(400, `duration_exceeds_max:${env.otMaxContinuousMinutes}min`);
  }

  return markWorkCompleted(request.id, request.staffId, request.date, "STAFF_REPORTED", null, actor.staffId, meta, { timeIn, timeOut });
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
    if (await confirmAndLabelOtPunches(staffId, request.timeIn, request.timeOut)) {
      await markWorkCompleted(request.id, staffId, request.date, "DEVICE", null, staffId);
      completedAny = true;
    }
  }
  return completedAny;
}

/**
 * HR's override for completing an approved OT request without the staff
 * member's own self-report (reportOvertimeCompletion is the normal path —
 * see that function). Tries a real OVERTIME_IN/OVERTIME_OUT device-punch
 * match first; if none exists, HR can force it with `manual: true` (staff
 * unavailable, device offline, etc.), recorded as completionSource "MANUAL"
 * with the given note for audit purposes. Payroll totals only count
 * requests that reach this state, not merely "approved". */
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

  const deviceConfirmed = await confirmAndLabelOtPunches(request.staffId, request.timeIn, request.timeOut);
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
    return { date: r.date, timeIn: r.timeIn, timeOut: r.timeOut, reason: r.reason, hours, isHoliday: r.isHoliday, rateValue, payableHours, cost };
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
    select: { id: true, fullName: true, staffId: true, designation: true, nationalIdEnc: true },
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
        nationalId: decryptField(s.nationalIdEnc),
        basicSalary,
        normalHours: round2(normalHours),
        deductedHours: round2(deductedHours),
        eligibleHours: round2(normalHours - deductedHours),
        // Holiday OT hours are never subject to the daily catch-up
        // deduction (see OtRateInfo.gapHours) — so "Deducted Holidays" is
        // always 0 and "Eligible Holidays" always equals Holiday Hrs. Kept
        // as separate fields (rather than reusing holidayHours) so the
        // report columns below stay self-explanatory even though they're
        // trivial today.
        deductedHolidayHours: 0,
        eligibleHolidayHours: round2(holidayHours),
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
    title: `Monthly OT Sheet _ ${otPeriodLabel(month, year)}`,
    subtitle: "Kinbidhoo School, Th. Kinbidhoo",
    landscape: true,
    columns: [
      { header: "#", width: 18 },
      { header: "ID Card", width: 48 },
      { header: "Staff Full Name", width: 68 },
      { header: "Designation", width: 58 },
      { header: "Self Capped", width: 40 },
      { header: "Basic Salary", width: 50 },
      { header: "Normal Days", width: 45 },
      { header: "Holidays", width: 42 },
      { header: "Deducted Normal Day", width: 45 },
      { header: "Deducted Holidays", width: 42 },
      { header: "Eligible Normal Days", width: 45 },
      { header: "Eligible Holidays", width: 42 },
      { header: "OT Worked (w/o Cap)", width: 52 },
      { header: "Self Capped (Only)", width: 52 },
      { header: "All Capped (Final)", width: 52 },
    ],
    rows: rows.map((r, i) => [
      i + 1,
      r.nationalId,
      r.fullName,
      r.designation,
      "YES",
      r.basicSalary ?? "—",
      formatHm(r.normalHours),
      formatHm(r.holidayHours),
      formatHm(r.deductedHours),
      formatHm(r.deductedHolidayHours),
      formatHm(r.eligibleHours),
      formatHm(r.eligibleHolidayHours),
      r.totalCost,
      r.selfCappedAmount,
      r.allCappedFinal,
    ]),
    totalsRow: ["", "", "", "", "", "Total", "", "", "", "", "", "", totalWithoutCap, totalSelfCapped, totalAllCapped],
    signoff: [{ label: "Checked By" }, { label: "Head of School" }],
  });
}

export async function overtimeReportExcel(requester: AuthUser, departmentId: string | undefined, month: number, year: number): Promise<Buffer> {
  const rows = await overtimeReport(requester, departmentId, month, year);
  return buildReportExcel({
    title: `Monthly OT Sheet _ ${otPeriodLabel(month, year)}`,
    subtitle: "Kinbidhoo School, Th. Kinbidhoo",
    sheetName: "OT Sheet",
    columns: [
      { header: "#", key: "n", width: 5 },
      { header: "ID Card", key: "nationalId", width: 14 },
      { header: "Staff Full Name", key: "fullName", width: 24 },
      { header: "Designation", key: "designation", width: 22 },
      { header: "Self Capped", key: "selfCapped", width: 12 },
      { header: "Basic Salary", key: "basicSalary", width: 14, money: true },
      { header: "Normal Days (Hrs,Min)", key: "normalHoursHm", width: 16 },
      { header: "Holidays (Hrs,Min)", key: "holidayHoursHm", width: 16 },
      { header: "Deducted Normal Day (Hrs,Min)", key: "deductedHoursHm", width: 18 },
      { header: "Deducted Holidays (Hrs,Min)", key: "deductedHolidayHoursHm", width: 18 },
      { header: "Eligible Normal Days (Hrs,Min)", key: "eligibleHoursHm", width: 18 },
      { header: "Eligible Holidays (Hrs,Min)", key: "eligibleHolidayHoursHm", width: 18 },
      { header: "OT Worked (Without Cap) Amount", key: "totalCost", width: 18, money: true },
      { header: "Self Capped (Only) Amount", key: "selfCappedAmount", width: 16, money: true },
      { header: "All Capped (Final) Amount", key: "allCappedFinal", width: 16, money: true },
    ],
    rows: rows.map((r, i) => ({
      n: i + 1,
      nationalId: r.nationalId,
      fullName: r.fullName,
      designation: r.designation,
      selfCapped: "YES",
      basicSalary: r.basicSalary ?? "",
      normalHoursHm: formatHm(r.normalHours),
      holidayHoursHm: formatHm(r.holidayHours),
      deductedHoursHm: formatHm(r.deductedHours),
      deductedHolidayHoursHm: formatHm(r.deductedHolidayHours),
      eligibleHoursHm: formatHm(r.eligibleHours),
      eligibleHolidayHoursHm: formatHm(r.eligibleHolidayHours),
      totalCost: r.totalCost,
      selfCappedAmount: r.selfCappedAmount,
      allCappedFinal: r.allCappedFinal,
    })),
    totalsRow: {
      designation: "Total",
      totalCost: round2(rows.reduce((s, r) => s + r.totalCost, 0)),
      selfCappedAmount: round2(rows.reduce((s, r) => s + r.selfCappedAmount, 0)),
      allCappedFinal: round2(rows.reduce((s, r) => s + r.allCappedFinal, 0)),
    },
  });
}

const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/**
 * Individual Staff OT Details Sheet — one block per staff member (a Staff
 * Name/ID Card No/Designation/Record Card No header, then a two-row table
 * header, then one row per payable OT slot for the period) matching the
 * legacy portal's per-staff OT export. Staff with no payable OT that period
 * are omitted entirely — no empty block.
 *
 * Per-row "OT Capped"/"All Capped" amounts: the self-cap and school-wide
 * budget-cap (see overtimeReport's doc comment) only make sense applied to
 * a period's summed cost, not a single slot — so this reuses that staff
 * member's already-computed aggregate cap ratio (capped-total ÷ raw-total)
 * and applies it proportionally to each slot's own raw cost, which keeps
 * the printed rows summing to the same totals as the Monthly OT Sheet.
 */
export async function individualOtDetailsExcel(
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

  const staffList = await prisma.staff.findMany({
    where: deptId ? { departmentId: deptId } : {},
    select: { id: true, fullName: true, staffId: true, designation: true, nationalIdEnc: true },
    orderBy: { staffId: "asc" },
  });

  const [reportRows, summaries] = await Promise.all([
    overtimeReport(requester, departmentId, month, year),
    Promise.all(staffList.map((s) => monthlySummary(requester, s.id, month, year).catch(() => null))),
  ]);
  const reportRowByStaff = new Map(reportRows.map((r) => [r.staffId, r]));

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Individual Staff OT");
  const COLS = 17;
  sheet.columns = Array.from({ length: COLS }, () => ({ width: 12 }));

  function mergedRow(text: string, opts: { bold?: boolean; size?: number } = {}) {
    const row = sheet.addRow([text]);
    sheet.mergeCells(row.number, 1, row.number, COLS);
    row.font = { bold: opts.bold ?? true, size: opts.size ?? 11 };
    return row;
  }

  mergedRow("Kinbidhoo School", { size: 14 });
  mergedRow("Th. Kinbidhoo", { size: 10, bold: false });
  sheet.addRow([]);
  mergedRow(`Individual Staff OT Details Sheet _ ${otPeriodLabel(month, year)}`, { size: 12 });
  sheet.addRow([]);

  const headerLabels = [
    "S.No",
    "Salary",
    "Date",
    "Day",
    "Holiday",
    "Non-Official",
    "OT In",
    "OT Out",
    "Description",
    "Worked (Hrs)",
    "Worked (Min)",
    "Eligible (Hrs)",
    "Eligible (Min)",
    "Total (Amount)",
    "OT Capped (Amount)",
    "All Capped (Final Amount)",
    "Status",
  ];

  staffList.forEach((s, idx) => {
    const summary = summaries[idx];
    const rows = summary?.rows ?? [];
    if (rows.length === 0) return; // no payable OT this period — skip the block entirely

    const reportRow = reportRowByStaff.get(s.id);
    const selfCapRatio = reportRow && reportRow.totalCost > 0 ? reportRow.selfCappedAmount / reportRow.totalCost : 1;
    const allCapRatio = reportRow && reportRow.totalCost > 0 ? reportRow.allCappedFinal / reportRow.totalCost : 1;

    mergedRow(`Staff Name: ${s.fullName}`, { bold: true, size: 10 });
    mergedRow(`ID Card No: ${decryptField(s.nationalIdEnc)}`, { bold: false, size: 10 });
    mergedRow(`Designation: ${s.designation}`, { bold: false, size: 10 });
    mergedRow(`Record Card No: ${s.staffId}`, { bold: false, size: 10 });

    const headerRow = sheet.addRow(headerLabels);
    headerRow.font = { bold: true };
    headerRow.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };
    });

    rows.forEach((r, i) => {
      const workedTotalMinutes = Math.round(r.hours * 60);
      const eligibleTotalMinutes = Math.round(r.payableHours * 60);
      const dayOfWeek = r.date.getDay();
      const cost = r.cost ?? 0;

      sheet.addRow([
        i + 1,
        reportRow?.basicSalary ?? "",
        r.date.toISOString().slice(0, 10),
        DAY_NAMES[dayOfWeek],
        r.isHoliday ? "YES" : "NO",
        dayOfWeek === 5 || dayOfWeek === 6 ? "YES" : "NO",
        r.timeIn.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        r.timeOut.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        r.reason,
        Math.floor(workedTotalMinutes / 60),
        workedTotalMinutes % 60,
        Math.floor(eligibleTotalMinutes / 60),
        eligibleTotalMinutes % 60,
        round2(cost),
        round2(cost * selfCapRatio),
        round2(cost * allCapRatio),
        "Approved",
      ]);
    });

    sheet.addRow([]);
  });

  return Buffer.from(await workbook.xlsx.writeBuffer());
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
