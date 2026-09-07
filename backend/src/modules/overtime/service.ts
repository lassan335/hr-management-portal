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
import { shiftSettingsFor } from "../attendance/timesheet";
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
    map.set(s.id, { basicSalary, ratePerMinuteNormal, ratePerMinuteHoliday });
  }
  return map;
}

/** Uncapped cost for one slot — the 10%-of-Basic-Salary self-cap only makes
 * sense applied to a period's summed normal-day cost, not a single slot, so
 * callers showing a per-slot amount (the request list, the ledger) show the
 * true uncapped figure; only the monthly/report totals are capped. */
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
  let requests;
  if (requester.role === Role.HR_ADMIN) {
    requests = await prisma.overtimeRequest.findMany({
      where: { status: { in: ["PENDING_HOD", "PENDING_HR"] }, cancelled: false },
      orderBy: { createdAt: "asc" },
      include: { staff: { select: { fullName: true, staffId: true, departmentId: true } } },
    });
  } else if (requester.role === Role.HOD) {
    requests = await prisma.overtimeRequest.findMany({
      where: { status: "PENDING_HOD", cancelled: false, staff: { departmentId: requester.departmentId ?? "__none__" } },
      orderBy: { createdAt: "asc" },
      include: { staff: { select: { fullName: true, staffId: true, departmentId: true } } },
    });
  } else {
    requests = await prisma.overtimeRequest.findMany({
      where: { staffId: requester.staffId },
      orderBy: { createdAt: "desc" },
      include: { hodReviewer: { select: { fullName: true } }, hrReviewer: { select: { fullName: true } } },
    });
  }

  // Estimated amount per slot (uncapped — see otCostForRequest) so staff
  // can see roughly what a request is worth before it's even approved,
  // not just once it appears in the monthly summary.
  const rateMap = await otRateInfoForStaffIds(requests.map((r) => r.staffId));
  return requests.map((r) => ({
    ...r,
    estimatedCost: otCostForRequest(rateMap.get(r.staffId), hoursBetween(r.timeIn, r.timeOut), r.isHoliday),
  }));
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
  const rateMap = await otRateInfoForStaffIds([staffId]);
  const info = rateMap.get(staffId);

  let totalHours = 0;
  let normalCostRaw = 0;
  let holidayCost = 0;
  const rows = requests.map((r) => {
    const hours = hoursBetween(r.timeIn, r.timeOut);
    totalHours += hours;
    const cost = otCostForRequest(info, hours, r.isHoliday);
    if (cost !== null) {
      if (r.isHoliday) holidayCost += cost;
      else normalCostRaw += cost;
    }
    // Displayed as an hourly-equivalent rate (rate/min * 60) so it reads
    // like the familiar MVR-per-hour figures HR is used to, even though the
    // underlying formula works in per-minute terms.
    const ratePerMinute = r.isHoliday ? info?.ratePerMinuteHoliday ?? null : info?.ratePerMinuteNormal ?? null;
    const rateValue = ratePerMinute != null ? round2(ratePerMinute * 60) : null;
    return { date: r.date, timeIn: r.timeIn, timeOut: r.timeOut, hours, isHoliday: r.isHoliday, rateValue, cost };
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
    select: {
      id: true,
      fullName: true,
      staffId: true,
      designation: true,
      staffGroup: true,
      bankDetails: { select: { basicSalaryEnc: true } },
    },
    orderBy: { staffId: "asc" },
  });

  const rows = await Promise.all(
    staffList.map(async (s) => {
      const summary = await monthlySummary(requester, s.id, month, year).catch(() => null);
      let normalHours = 0;
      let holidayHours = 0;
      for (const r of summary?.rows ?? []) {
        if (r.isHoliday) holidayHours += r.hours;
        else normalHours += r.hours;
      }

      const basicSalary = s.bankDetails?.basicSalaryEnc ? Number(decryptField(s.bankDetails.basicSalaryEnc)) : null;
      const standardDailyHours = shiftSettingsFor(s.staffGroup).standardDailyHours;

      let normalCostRaw = 0;
      let holidayCost = 0;
      let selfCappedAmount = 0;
      if (basicSalary != null && standardDailyHours > 0) {
        const perMinuteBase = basicSalary / env.otRateCalendarDays / (standardDailyHours * 60);
        const ratePerMinuteNormal = perMinuteBase * env.otNormalRateMultiplier;
        const ratePerMinuteHoliday = perMinuteBase * env.otHolidayRateMultiplier;
        normalCostRaw = normalHours * 60 * ratePerMinuteNormal;
        holidayCost = holidayHours * 60 * ratePerMinuteHoliday;
        const normalCostCapped = Math.min(normalCostRaw, basicSalary * env.otSelfCapPercent);
        selfCappedAmount = round2(normalCostCapped + holidayCost);
      }

      return {
        staffId: s.id,
        staffCode: s.staffId,
        fullName: s.fullName,
        designation: s.designation,
        basicSalary,
        normalHours: round2(normalHours),
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
      { header: "Name", width: 110 },
      { header: "Designation", width: 100 },
      { header: "Basic Salary", width: 65 },
      { header: "Normal Hrs", width: 55 },
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
      r.holidayHours,
      r.totalCost,
      r.selfCappedAmount,
      r.allCappedFinal,
    ]),
    totalsRow: ["", "", "", "Total", "", "", "", totalWithoutCap, totalSelfCapped, totalAllCapped],
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
  return requests.map((r) => {
    const info = rateMap.get(r.staff.id);
    const hours = hoursBetween(r.timeIn, r.timeOut);
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
      cost: otCostForRequest(info, hours, r.isHoliday),
    };
  });
}
