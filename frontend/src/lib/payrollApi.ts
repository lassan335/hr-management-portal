import { api, API_URL } from "./api";

export interface PayrollReadyStaff {
  id: string;
  staffId: string;
  fullName: string;
  designation: string;
  departmentId: string;
}

export interface Adjustment {
  mibDeduction: number | string;
  otherDeduction: number | string;
  absentDeduction: number | string;
  attendanceAllowancePerDay: number | string;
}

export interface SalarySlip {
  staffId: string;
  staffCode: string;
  fullName: string;
  designation: string;
  month: number;
  year: number;
  periodLabel: string;
  periodFrom: string;
  periodTo: string;
  basicSalary: number;
  serviceAllowance: number;
  jobAllowance: number;
  daysInPeriod: number;
  unpaidLeaveDays: number;
  payableDays: number;
  lateMinutesTotal: number;
  lateDeduction: number;
  absentDeduction: number;
  serviceDeduction: number;
  jobDeduction: number;
  jobAllowanceNet: number;
  salaryAfterLateAbsent: number;
  mibDeduction: number;
  pensionDeduction: number;
  otherDeduction: number;
  totalOtherDeduction: number;
  overtimeAllowance: number;
  daysPresent: number;
  attendanceAllowancePerDay: number;
  attendanceAllowance: number;
  totalIncome: number;
  netPay: number;
}

export const payrollApi = {
  ready: (departmentId?: string) => {
    const params = new URLSearchParams(departmentId ? { departmentId } : {});
    const qs = params.toString();
    return api.get<PayrollReadyStaff[]>(`/api/payroll/ready${qs ? `?${qs}` : ""}`);
  },
  getAdjustment: (staffId: string, month: number, year: number) =>
    api.get<Adjustment>(`/api/payroll/adjustments/${staffId}?month=${month}&year=${year}`),
  saveAdjustment: (staffId: string, input: { month: number; year: number } & Adjustment) =>
    api.put<Adjustment>(`/api/payroll/adjustments/${staffId}`, input),
  slip: (staffId: string, month: number, year: number) =>
    api.get<SalarySlip>(`/api/payroll/slip/${staffId}?month=${month}&year=${year}`),
  slipPdfUrl: (staffId: string, month: number, year: number) =>
    `${API_URL}/api/payroll/slip/${staffId}?month=${month}&year=${year}&format=pdf`,
  slipExcelUrl: (staffId: string, month: number, year: number) =>
    `${API_URL}/api/payroll/slip/${staffId}?month=${month}&year=${year}&format=excel`,
  /** Bulk salary sheet — Excel by default (a flat, one-row-per-staff
   * register, matching the legacy spreadsheet this covers 50+ staff at
   * once), with a PDF option alongside for a printable copy. */
  bulkUrl: (month: number, year: number, departmentId: string | undefined, format: "excel" | "pdf" = "excel") => {
    const params = new URLSearchParams({ month: String(month), year: String(year), format, ...(departmentId ? { departmentId } : {}) });
    return `${API_URL}/api/payroll/bulk?${params.toString()}`;
  },
};
