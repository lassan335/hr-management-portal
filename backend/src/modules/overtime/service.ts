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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Monthly OT Sheet — per-staff Normal/Holiday hour and cost breakdown for
 * the pay period, matching the legacy portal's school-wide overtime report.
 *
 * Deliberately NOT implemented here (see README's "Deferred / out of
 * scope"): the "Deducted"/"Eligible" hour columns and the "Self Capped"/
 * "All Capped" amount tiers — those depend on a capping rule (against basic
 * salary and/or a school-wide OT budget) that isn't configured anywhere in
 * this system, and guessing it would risk silently misreporting real pay
 * figures instead of leaving it correctly uncapped by default.
 *
 * `caps` lets HR apply a real policy when they have the actual numbers:
 * `normalCapHours`/`holidayCapHours` are a per-staff ceiling on eligible
 * hours for the whole period (hours worked beyond it are "Deducted", the
 * rest "Eligible" — Self Capped Amount pays only for eligible hours);
 * `budgetCap` is a single school-wide ceiling applied to the sum of every
 * staff member's Self Capped Amount in this report, distributed in the
 * report's row order (All Capped Final Amount). Leaving a cap unset pays
 * the true worked-hours cost for that column, same as before this existed.
 */
export interface OvertimeCapOptions {
  normalCapHours?: number;
  holidayCapHours?: number;
  budgetCap?: number;
}

export async function overtimeReport(
  requester: AuthUser,
  departmentId: string | undefined,
  month: number,
  year: number,
  caps: OvertimeCapOptions = {}
) {
  let deptId = departmentId;
  if (requester.role === Role.HOD) {
    deptId = requester.departmentId ?? "__none__";
  } else if (requester.role !== Role.HR_ADMIN) {
    throw new HttpError(403, "forbidden");
  }

  const selfCapped = caps.normalCapHours != null || caps.holidayCapHours != null;

  const staffList = await prisma.staff.findMany({
    where: deptId ? { departmentId: deptId } : {},
    select: { id: true, fullName: true, staffId: true, designation: true, bankDetails: { select: { basicSalaryEnc: true } } },
    orderBy: { staffId: "asc" },
  });

  const rows = await Promise.all(
    staffList.map(async (s) => {
      const summary = await monthlySummary(requester, s.id, month, year).catch(() => null);
      let normalHours = 0;
      let normalCost = 0;
      let holidayHours = 0;
      let holidayCost = 0;
      for (const r of summary?.rows ?? []) {
        if (r.isHoliday) {
          holidayHours += r.hours;
          holidayCost += r.cost ?? 0;
        } else {
          normalHours += r.hours;
          normalCost += r.cost ?? 0;
        }
      }

      const eligibleNormalHours = caps.normalCapHours != null ? Math.min(normalHours, caps.normalCapHours) : normalHours;
      const eligibleHolidayHours = caps.holidayCapHours != null ? Math.min(holidayHours, caps.holidayCapHours) : holidayHours;
      const deductedNormalHours = round2(normalHours - eligibleNormalHours);
      const deductedHolidayHours = round2(holidayHours - eligibleHolidayHours);
      // Scale each column's cost by its eligible share of worked hours —
      // a defensible simplification when a period mixes several OT rates,
      // since we cap total hours rather than picking which specific slots
      // to disallow.
      const selfCappedNormalCost = normalHours > 0 ? round2((eligibleNormalHours / normalHours) * normalCost) : 0;
      const selfCappedHolidayCost = holidayHours > 0 ? round2((eligibleHolidayHours / holidayHours) * holidayCost) : 0;
      const selfCappedAmount = round2(selfCappedNormalCost + selfCappedHolidayCost);

      return {
        staffId: s.id,
        staffCode: s.staffId,
        fullName: s.fullName,
        designation: s.designation,
        basicSalary: s.bankDetails?.basicSalaryEnc ? Number(decryptField(s.bankDetails.basicSalaryEnc)) : null,
        selfCapped,
        normalHours: round2(normalHours),
        holidayHours: round2(holidayHours),
        deductedNormalHours,
        deductedHolidayHours,
        eligibleNormalHours: round2(eligibleNormalHours),
        eligibleHolidayHours: round2(eligibleHolidayHours),
        normalCost: round2(normalCost),
        holidayCost: round2(holidayCost),
        totalCost: round2(normalCost + holidayCost),
        selfCappedAmount,
      };
    })
  );

  // Budget cap: one school-wide ceiling on the sum of everyone's Self
  // Capped Amount, distributed across staff in report order until exhausted.
  let remainingBudget = caps.budgetCap ?? Infinity;
  const withFinal = rows.map((r) => {
    const allCappedFinal = round2(Math.min(r.selfCappedAmount, Math.max(0, remainingBudget)));
    remainingBudget -= allCappedFinal;
    return { ...r, allCappedFinal };
  });

  return withFinal;
}

function otPeriodLabel(month: number, year: number): string {
  const { from, to } = otPeriodRange(month, year);
  const fmt = (d: Date) => `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
  return `${fmt(from)} to ${fmt(to)}`;
}

export async function overtimeReportPdf(
  requester: AuthUser,
  departmentId: string | undefined,
  month: number,
  year: number,
  caps: OvertimeCapOptions = {}
): Promise<Buffer> {
  const rows = await overtimeReport(requester, departmentId, month, year, caps);
  const totalWithoutCap = round2(rows.reduce((s, r) => s + r.totalCost, 0));
  const totalSelfCapped = round2(rows.reduce((s, r) => s + r.selfCappedAmount, 0));
  const totalAllCapped = round2(rows.reduce((s, r) => s + r.allCappedFinal, 0));
  return buildTablePdf({
    title: "Monthly OT Sheet",
    subtitle: `Kinbidhoo School — ${otPeriodLabel(month, year)}`,
    landscape: true,
    columns: [
      { header: "#", width: 20 },
      { header: "Staff ID", width: 50 },
      { header: "Name", width: 80 },
      { header: "Designation", width: 75 },
      { header: "Self Capped", width: 40 },
      { header: "Basic Salary", width: 50 },
      { header: "Normal Hrs", width: 40 },
      { header: "Holiday Hrs", width: 40 },
      { header: "Ded. Normal", width: 42 },
      { header: "Ded. Holiday", width: 42 },
      { header: "Elig. Normal", width: 42 },
      { header: "Elig. Holiday", width: 42 },
      { header: "OT w/o Cap", width: 50 },
      { header: "Self Capped", width: 50 },
      { header: "All Capped", width: 50 },
    ],
    rows: rows.map((r, i) => [
      i + 1,
      r.staffCode,
      r.fullName,
      r.designation,
      r.selfCapped ? "YES" : "NO",
      r.basicSalary ?? "—",
      r.normalHours,
      r.holidayHours,
      r.deductedNormalHours,
      r.deductedHolidayHours,
      r.eligibleNormalHours,
      r.eligibleHolidayHours,
      r.totalCost,
      r.selfCappedAmount,
      r.allCappedFinal,
    ]),
    totalsRow: ["", "", "", "", "", "Total", "", "", "", "", "", "", totalWithoutCap, totalSelfCapped, totalAllCapped],
    signoff: [{ label: "Checked by" }, { label: "Approved by" }],
  });
}

export async function overtimeReportExcel(
  requester: AuthUser,
  departmentId: string | undefined,
  month: number,
  year: number,
  caps: OvertimeCapOptions = {}
): Promise<Buffer> {
  const rows = await overtimeReport(requester, departmentId, month, year, caps);
  return buildReportExcel({
    title: "Monthly OT Sheet",
    subtitle: `Kinbidhoo School — ${otPeriodLabel(month, year)}`,
    sheetName: "OT Sheet",
    columns: [
      { header: "#", key: "n", width: 5 },
      { header: "Staff ID", key: "staffCode", width: 12 },
      { header: "Name", key: "fullName", width: 24 },
      { header: "Designation", key: "designation", width: 24 },
      { header: "Self Capped", key: "selfCappedLabel", width: 12 },
      { header: "Basic Salary", key: "basicSalary", width: 14, money: true },
      { header: "Normal Hrs", key: "normalHours", width: 12, money: true },
      { header: "Holiday Hrs", key: "holidayHours", width: 12, money: true },
      { header: "Deducted Normal", key: "deductedNormalHours", width: 15, money: true },
      { header: "Deducted Holiday", key: "deductedHolidayHours", width: 15, money: true },
      { header: "Eligible Normal", key: "eligibleNormalHours", width: 14, money: true },
      { header: "Eligible Holiday", key: "eligibleHolidayHours", width: 14, money: true },
      { header: "OT Worked (Without Cap)", key: "totalCost", width: 20, money: true },
      { header: "Self Capped (Only)", key: "selfCappedAmount", width: 16, money: true },
      { header: "All Capped (Final)", key: "allCappedFinal", width: 16, money: true },
    ],
    rows: rows.map((r, i) => {
      const { selfCapped, ...rest } = r;
      return { n: i + 1, ...rest, selfCappedLabel: selfCapped ? "YES" : "NO", basicSalary: r.basicSalary ?? "" };
    }),
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
