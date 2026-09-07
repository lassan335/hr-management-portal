import { AuthUser, Role } from "@hr/shared";
import { prisma } from "../../lib/prisma";
import { decryptField } from "../../lib/encryption";
import { recordAudit } from "../../lib/audit";
import { HttpError } from "../../lib/errors";
import { payPeriodRange } from "../../lib/dateRange";
import { env } from "../../lib/env";
import { buildTimesheet, shiftSettingsFor } from "../attendance/timesheet";
import { monthlySummary as overtimeMonthlySummary } from "../overtime/service";
import { buildSalarySlipPdf, buildBulkSalarySlipPdf } from "../../lib/payrollPdf";
import type { SalarySlipData } from "../../lib/payrollPdf";
import { buildSalarySlipExcel, buildBulkSalarySlipExcel } from "../../lib/payrollExcel";
import type { adjustmentSchema } from "./validation";
import type { z } from "zod";

type AuditMeta = { ipAddress?: string; userAgent?: string };

const SCHOOL_NAME = "Kinbidhoo School";
const SCHOOL_ADDRESS = "Th. Kinbidhoo";
const PENSION_RATE = 0.07;

function requireHrAdmin(actor: AuthUser) {
  if (actor.role !== Role.HR_ADMIN) throw new HttpError(403, "forbidden");
}

/** Salary slips are viewable by HR/Admin (anyone's) or the staff member
 * themselves (their own only) — unlike bank-details edit access, which stays
 * HR-only even for self, a payslip is normally something an employee can see. */
function requireHrAdminOrSelf(actor: AuthUser, staffId: string) {
  if (actor.role !== Role.HR_ADMIN && actor.staffId !== staffId) throw new HttpError(403, "forbidden");
}

function monthLabel(month: number, year: number): string {
  return new Date(year, month - 1, 1).toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

/** `from`/`to` are local-midnight Date objects (see payPeriodRange) —
 * .toISOString() converts to UTC first, which rolls the displayed date back
 * a day in any timezone ahead of UTC. Format from local components instead. */
function toLocalDateString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function daysInclusive(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
}

function clampRange(aFrom: Date, aTo: Date, bFrom: Date, bTo: Date): number {
  const from = aFrom > bFrom ? aFrom : bFrom;
  const to = aTo < bTo ? aTo : bTo;
  if (from > to) return 0;
  return daysInclusive(from, to);
}

async function getAdjustmentInternal(staffId: string, month: number, year: number) {
  const existing = await prisma.salarySlipAdjustment.findUnique({
    where: { staffId_month_year: { staffId, month, year } },
  });
  return existing ?? { mibDeduction: 0, otherDeduction: 0, absentDeduction: 0, attendanceAllowancePerDay: 0 };
}

/** HR/Admin-only route handler — the raw adjustment inputs (MIB, other
 * deductions, etc.) are an editing surface, not something staff need to see
 * directly (they see the computed slip instead, via computeSalarySlip). */
export async function getAdjustment(actor: AuthUser, staffId: string, month: number, year: number) {
  requireHrAdmin(actor);
  return getAdjustmentInternal(staffId, month, year);
}

export async function upsertAdjustment(
  actor: AuthUser,
  staffId: string,
  input: z.infer<typeof adjustmentSchema>,
  meta: AuditMeta = {}
) {
  requireHrAdmin(actor);
  const data = {
    mibDeduction: input.mibDeduction,
    otherDeduction: input.otherDeduction,
    absentDeduction: input.absentDeduction,
    attendanceAllowancePerDay: input.attendanceAllowancePerDay,
    updatedBy: actor.staffId,
  };
  const saved = await prisma.salarySlipAdjustment.upsert({
    where: { staffId_month_year: { staffId, month: input.month, year: input.year } },
    create: { staffId, month: input.month, year: input.year, ...data },
    update: data,
  });
  await recordAudit({
    actorId: actor.staffId,
    action: "SALARY_ADJUSTMENT_SET",
    entity: "SalarySlipAdjustment",
    entityId: saved.id,
    after: { staffId, month: input.month, year: input.year, ...data, updatedBy: undefined },
    ...meta,
  });
  return saved;
}

/**
 * Computes one staff member's salary slip for a pay period (16th of the
 * previous month -> 15th, same convention as the Overtime module's period).
 *
 * Formulas verified against a real payslip sample where possible: Pension
 * is 7% of Basic Salary, Total Other Deduction = MIB + Pension + Others, and
 * Net Pay = Total Income - Total Other Deduction. Everything else (the late
 * -minute deduction rate, the unpaid-leave-day proration of Service/Job
 * Allowance, the attendance-allowance daily rate) is a documented, internally
 * consistent approximation rather than a reproduction of the exact legacy
 * spreadsheet formula, which isn't recoverable from a flattened export —
 * see README's "Deferred / out of scope" for the tradeoff this accepts.
 */
export async function computeSalarySlip(actor: AuthUser, staffId: string, month: number, year: number) {
  requireHrAdminOrSelf(actor, staffId);

  const staff = await prisma.staff.findUnique({
    where: { id: staffId },
    include: { staffGroup: true, bankDetails: true },
  });
  if (!staff) throw new HttpError(404, "not_found");
  if (!staff.bankDetails?.basicSalaryEnc) {
    throw new HttpError(400, "payroll_not_configured");
  }

  const basicSalary = Number(decryptField(staff.bankDetails.basicSalaryEnc));
  const serviceAllowance = staff.bankDetails.serviceAllowanceEnc ? Number(decryptField(staff.bankDetails.serviceAllowanceEnc)) : 0;
  const jobAllowance = staff.bankDetails.jobAllowanceEnc ? Number(decryptField(staff.bankDetails.jobAllowanceEnc)) : 0;

  const { from, to } = payPeriodRange(month, year, env.otPeriodStartDay);
  const daysInPeriod = daysInclusive(from, to);

  const [entries, unpaidLeave, adjustment, overtime] = await Promise.all([
    prisma.timeEntry.findMany({ where: { staffId, timestamp: { gte: from, lte: to } }, orderBy: { timestamp: "asc" } }),
    prisma.leaveRequest.findMany({
      where: { staffId, status: "APPROVED", leaveType: { deductsBalance: false }, startDate: { lte: to }, endDate: { gte: from } },
    }),
    getAdjustmentInternal(staffId, month, year),
    overtimeMonthlySummary(actor, staffId, month, year),
  ]);

  const days = buildTimesheet(entries, shiftSettingsFor(staff.staffGroup));
  const lateMinutesTotal = days.reduce((sum, d) => sum + d.lateMinutes, 0);
  const daysPresent = days.filter((d) => d.hoursWorked > 0).length;
  const unpaidLeaveDays = unpaidLeave.reduce((sum, r) => sum + clampRange(r.startDate, r.endDate, from, to), 0);
  const payableDays = Math.max(0, daysInPeriod - unpaidLeaveDays);

  const standardDailyMinutes = shiftSettingsFor(staff.staffGroup).standardDailyHours * 60;
  const perMinuteRate = daysInPeriod > 0 && standardDailyMinutes > 0 ? basicSalary / (daysInPeriod * standardDailyMinutes) : 0;
  const lateDeduction = Math.round(perMinuteRate * lateMinutesTotal * 100) / 100;
  const absentDeduction = Number(adjustment.absentDeduction);

  const unpaidShare = daysInPeriod > 0 ? unpaidLeaveDays / daysInPeriod : 0;
  const serviceDeduction = Math.round(serviceAllowance * unpaidShare * 100) / 100;
  const jobDeduction = Math.round(jobAllowance * unpaidShare * 100) / 100;
  const jobAllowanceNet = Math.round((jobAllowance - jobDeduction) * 100) / 100;

  const salaryAfterLateAbsent = Math.round((basicSalary - lateDeduction - absentDeduction) * 100) / 100;

  const mibDeduction = Number(adjustment.mibDeduction);
  const pensionDeduction = Math.round(basicSalary * PENSION_RATE * 100) / 100;
  const otherDeduction = Number(adjustment.otherDeduction);
  const totalOtherDeduction = Math.round((mibDeduction + pensionDeduction + otherDeduction) * 100) / 100;

  const overtimeAllowance = overtime.totalCost;
  const attendanceAllowancePerDay = Number(adjustment.attendanceAllowancePerDay);
  const attendanceAllowance = Math.round(attendanceAllowancePerDay * daysPresent * 100) / 100;

  const totalIncome = Math.round((salaryAfterLateAbsent + overtimeAllowance + attendanceAllowance + jobAllowanceNet) * 100) / 100;
  const netPay = Math.round((totalIncome - totalOtherDeduction) * 100) / 100;

  return {
    staffId: staff.id,
    staffCode: staff.staffId,
    fullName: staff.fullName,
    designation: staff.designation,
    homeAddress: staff.homeAddress,
    nationalId: decryptField(staff.nationalIdEnc),
    bankName: staff.bankDetails.bankName,
    accountNumber: decryptField(staff.bankDetails.accountNumberEnc),
    month,
    year,
    periodLabel: monthLabel(month, year),
    periodFrom: toLocalDateString(from),
    periodTo: toLocalDateString(to),
    basicSalary,
    serviceAllowance,
    jobAllowance,
    daysInPeriod,
    unpaidLeaveDays,
    payableDays,
    lateMinutesTotal,
    lateDeduction,
    absentDeduction,
    serviceDeduction,
    jobDeduction,
    jobAllowanceNet,
    salaryAfterLateAbsent,
    mibDeduction,
    pensionDeduction,
    otherDeduction,
    totalOtherDeduction,
    overtimeAllowance,
    daysPresent,
    attendanceAllowancePerDay,
    attendanceAllowance,
    totalIncome,
    netPay,
  };
}

function mvr(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function toSlipData(slip: Awaited<ReturnType<typeof computeSalarySlip>>): SalarySlipData {
  return {
    schoolName: SCHOOL_NAME,
    schoolAddress: SCHOOL_ADDRESS,
    periodLabel: slip.periodLabel,
    staffName: slip.fullName.toUpperCase(),
    staffCode: slip.staffCode,
    nationalId: slip.nationalId,
    designation: slip.designation,
    homeAddress: slip.homeAddress,
    bankLine: `${slip.accountNumber} (${slip.bankName})`,
    lines: [
      { label: "Basic Salary", value: mvr(slip.basicSalary) },
      { label: "Payable Days", value: `${slip.payableDays} / ${slip.daysInPeriod}` },
      { label: "Deducted Late", value: mvr(slip.lateDeduction) },
      { label: "Deducted Absent", value: mvr(slip.absentDeduction) },
      { label: "Deducted From Service Allowance", value: mvr(slip.serviceDeduction) },
      { label: "Deducted From Job Allowance", value: mvr(slip.jobDeduction) },
      { label: "Salary After Late/Absent Deduction", value: mvr(slip.salaryAfterLateAbsent), bold: true },
      { label: "Deducted MIB", value: mvr(slip.mibDeduction) },
      { label: "Deducted Pension Scheme (7%)", value: mvr(slip.pensionDeduction) },
      { label: "Deducted Others", value: mvr(slip.otherDeduction) },
      { label: "Total Other Deduction", value: mvr(slip.totalOtherDeduction), bold: true },
      { label: "Overtime Allowance", value: mvr(slip.overtimeAllowance) },
      { label: "Attendance Allowance", value: mvr(slip.attendanceAllowance) },
      { label: "Attendance Allowance Days", value: String(slip.daysPresent) },
      { label: "Job Allowance", value: mvr(slip.jobAllowanceNet) },
      { label: "Total Income", value: mvr(slip.totalIncome), bold: true },
      { label: "Net Pay", value: mvr(slip.netPay), bold: true },
    ],
  };
}

export async function generateSalarySlipPdf(actor: AuthUser, staffId: string, month: number, year: number): Promise<Buffer> {
  const slip = await computeSalarySlip(actor, staffId, month, year);
  await recordAudit({
    actorId: actor.staffId,
    action: "SALARY_SLIP_GENERATED",
    entity: "Staff",
    entityId: staffId,
    after: { month, year, netPay: slip.netPay, format: "pdf" },
  });
  return buildSalarySlipPdf(toSlipData(slip));
}

export async function generateSalarySlipExcel(actor: AuthUser, staffId: string, month: number, year: number): Promise<Buffer> {
  const slip = await computeSalarySlip(actor, staffId, month, year);
  await recordAudit({
    actorId: actor.staffId,
    action: "SALARY_SLIP_GENERATED",
    entity: "Staff",
    entityId: staffId,
    after: { month, year, netPay: slip.netPay, format: "excel" },
  });
  return buildSalarySlipExcel(toSlipData(slip));
}

/** HR/Admin only — every staff member with payroll configured (optionally
 * scoped to one department). Shared by the PDF and Excel bulk exports. */
async function computeBulkSlips(actor: AuthUser, month: number, year: number, departmentId: string | undefined, format: string, meta: AuditMeta) {
  requireHrAdmin(actor);

  const staffList = await prisma.staff.findMany({
    where: {
      ...(departmentId ? { departmentId } : {}),
      bankDetails: { basicSalaryEnc: { not: null } },
    },
    select: { id: true },
    orderBy: { staffId: "asc" },
  });

  if (staffList.length === 0) throw new HttpError(400, "no_staff_with_payroll_configured");

  const slips = await Promise.all(staffList.map((s) => computeSalarySlip(actor, s.id, month, year)));

  await recordAudit({
    actorId: actor.staffId,
    action: "SALARY_SHEET_BULK_GENERATED",
    entity: "Department",
    entityId: departmentId ?? "ALL",
    after: { month, year, staffCount: slips.length, format },
    ...meta,
  });

  return slips;
}

export async function generateBulkSalarySlipPdf(
  actor: AuthUser,
  month: number,
  year: number,
  departmentId: string | undefined,
  meta: AuditMeta = {}
): Promise<Buffer> {
  const slips = await computeBulkSlips(actor, month, year, departmentId, "pdf", meta);
  return buildBulkSalarySlipPdf(slips.map(toSlipData));
}

export async function generateBulkSalarySlipExcel(
  actor: AuthUser,
  month: number,
  year: number,
  departmentId: string | undefined,
  meta: AuditMeta = {}
): Promise<Buffer> {
  const slips = await computeBulkSlips(actor, month, year, departmentId, "excel", meta);
  return buildBulkSalarySlipExcel(slips, monthLabel(month, year));
}

/** Staff with payroll figures configured — for the Payroll page's staff
 * picker, so HR only sees who a slip can actually be generated for. */
export async function listPayrollReadyStaff(actor: AuthUser, departmentId?: string) {
  requireHrAdmin(actor);
  return prisma.staff.findMany({
    where: {
      ...(departmentId ? { departmentId } : {}),
      bankDetails: { basicSalaryEnc: { not: null } },
    },
    select: { id: true, staffId: true, fullName: true, designation: true, departmentId: true },
    orderBy: { staffId: "asc" },
  });
}
