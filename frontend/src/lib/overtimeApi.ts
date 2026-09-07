import { api } from "./api";

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
  createdAt: string;
  staff?: { fullName: string; staffId: string };
  hodReviewer?: { fullName: string } | null;
  hrReviewer?: { fullName: string } | null;
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
  rows: { date: string; timeIn: string; timeOut: string; hours: number; isHoliday: boolean; rateValue: number | null; cost: number | null }[];
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

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

export const overtimeApi = {
  submit: (input: { date: string; timeIn: string; timeOut: string; reason: string; notes?: string; isHoliday?: boolean }) =>
    api.post<OvertimeRequestRow>("/api/overtime", input),
  list: () => api.get<OvertimeRequestRow[]>("/api/overtime"),
  review: (id: string, decision: "APPROVE" | "REJECT") => api.patch(`/api/overtime/${id}`, { decision }),
  cancel: (id: string) => api.post<OvertimeRequestRow>(`/api/overtime/${id}/cancel`, {}),
  complete: (id: string) => api.post<OvertimeRequestRow>(`/api/overtime/${id}/complete`, {}),
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
   * option. Caps are optional: left unset, the report shows the true
   * uncapped worked-hours cost. */
  reportUrl: (
    month: number,
    year: number,
    departmentId: string | undefined,
    format: "excel" | "pdf" = "excel",
    caps: { normalCapHours?: number; holidayCapHours?: number; budgetCap?: number } = {}
  ) => {
    const params = new URLSearchParams({
      month: String(month),
      year: String(year),
      format,
      ...(departmentId ? { departmentId } : {}),
      ...(caps.normalCapHours != null ? { normalCapHours: String(caps.normalCapHours) } : {}),
      ...(caps.holidayCapHours != null ? { holidayCapHours: String(caps.holidayCapHours) } : {}),
      ...(caps.budgetCap != null ? { budgetCap: String(caps.budgetCap) } : {}),
    });
    return `${API_URL}/api/overtime/report?${params.toString()}`;
  },
};
