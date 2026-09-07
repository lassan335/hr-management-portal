import { api, API_URL } from "./api";

export interface OvertimeRequestRow {
  id: string;
  staffId: string;
  date: string;
  timeIn: string;
  timeOut: string;
  reason: string;
  notes: string | null;
  isHoliday: boolean;
  status: string;
  cancelled: boolean;
  cancelledAt: string | null;
  workCompleted: boolean;
  workCompletedAt: string | null;
  /** "DEVICE" (matched a real OVERTIME_IN/OVERTIME_OUT time clock punch
   * pair) or "MANUAL" (HR override). Null until workCompleted. */
  completionSource: "DEVICE" | "MANUAL" | null;
  completionNote: string | null;
  createdAt: string;
  staff?: { fullName: string; staffId: string };
  hodReviewer?: { fullName: string } | null;
  hrReviewer?: { fullName: string } | null;
  /** Uncapped estimated MVR amount for this single slot — see the backend's
   * otCostForRequest(). Null when the staff member has no Basic Salary on file. */
  estimatedCost?: number | null;
}

export interface OvertimeRate {
  id: string;
  departmentId: string;
  weekdayRate: string;
  weekendRate: string;
  holidayRate: string;
  effectiveFrom: string;
}

export interface MonthlySummary {
  staffId: string;
  month: number;
  year: number;
  totalHours: number;
  totalCost: number;
  rows: {
    date: string;
    timeIn: string;
    timeOut: string;
    hours: number;
    isHoliday: boolean;
    rateValue: number | null;
    /** Hours actually paid, after the daily catch-up-to-8h deduction for
     * staff on a shorter-than-8h shift (never less than 0, never more than `hours`). */
    payableHours: number;
    cost: number | null;
  }[];
}

export interface DashboardRow {
  staffId: string;
  staffCode: string;
  fullName: string;
  totalHours: number;
  totalCost: number;
}

export interface LedgerRow {
  staffId: string;
  staffCode: string;
  fullName: string;
  date: string;
  timeIn: string;
  timeOut: string;
  hours: number;
  isHoliday: boolean;
  description: string;
  rateValue: number | null;
  cost: number | null;
}

export const overtimeApi = {
  submit: (input: { date: string; timeIn: string; timeOut: string; reason: string; notes?: string; isHoliday?: boolean }) =>
    api.post<OvertimeRequestRow>("/api/overtime", input),
  list: () => api.get<OvertimeRequestRow[]>("/api/overtime"),
  review: (id: string, decision: "APPROVE" | "REJECT") => api.patch(`/api/overtime/${id}`, { decision }),
  cancel: (id: string) => api.post<OvertimeRequestRow>(`/api/overtime/${id}/cancel`, {}),
  /** HR-only. Tries the real time-clock punch pair first; pass
   * `manual: true` (with an optional `note`) to force it when there's no
   * device confirmation yet — throws ApiError("no_device_confirmation") if
   * neither a punch nor `manual` is given. */
  complete: (id: string, options: { manual?: boolean; note?: string } = {}) =>
    api.post<OvertimeRequestRow>(`/api/overtime/${id}/complete`, options),
  setRate: (input: { departmentId: string; weekdayRate: number; weekendRate: number; holidayRate: number }) =>
    api.post<OvertimeRate>("/api/overtime/rates", input),
  getRate: (departmentId: string) => api.get<OvertimeRate | null>(`/api/overtime/rates/${departmentId}`),
  summary: (month: number, year: number, staffId?: string) => {
    const params = new URLSearchParams({ month: String(month), year: String(year), ...(staffId ? { staffId } : {}) });
    return api.get<MonthlySummary>(`/api/overtime/summary?${params.toString()}`);
  },
  summaryCsvUrl: (month: number, year: number, staffId?: string) => {
    const params = new URLSearchParams({ month: String(month), year: String(year), format: "csv", ...(staffId ? { staffId } : {}) });
    return `${API_URL}/api/overtime/summary?${params.toString()}`;
  },
  summaryPdfUrl: (month: number, year: number, staffId?: string) => {
    const params = new URLSearchParams({ month: String(month), year: String(year), format: "pdf", ...(staffId ? { staffId } : {}) });
    return `${API_URL}/api/overtime/summary?${params.toString()}`;
  },
  dashboard: (month: number, year: number, departmentId?: string) => {
    const params = new URLSearchParams({ month: String(month), year: String(year), ...(departmentId ? { departmentId } : {}) });
    return api.get<DashboardRow[]>(`/api/overtime/dashboard?${params.toString()}`);
  },
  ledger: (month: number, year: number, departmentId?: string) => {
    const params = new URLSearchParams({ month: String(month), year: String(year), ...(departmentId ? { departmentId } : {}) });
    return api.get<LedgerRow[]>(`/api/overtime/ledger?${params.toString()}`);
  },
  /** Monthly OT Sheet report — Excel by default (one row per staff), PDF
   * option. Rate/capping is automatic (Basic-Salary-derived, capped at 10%
   * of Basic for normal-day OT, plus a school-wide budget cap) — see the
   * backend's overtimeReport() for the verified formula. */
  reportUrl: (month: number, year: number, departmentId: string | undefined, format: "excel" | "pdf" = "excel") => {
    const params = new URLSearchParams({ month: String(month), year: String(year), format, ...(departmentId ? { departmentId } : {}) });
    return `${API_URL}/api/overtime/report?${params.toString()}`;
  },
};
