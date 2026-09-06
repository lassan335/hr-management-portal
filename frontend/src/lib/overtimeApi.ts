import { api } from "./api";

export interface OvertimeRequestRow {
  id: string;
  staffId: string;
  date: string;
  hours: number;
  reason: string;
  notes: string | null;
  isHoliday: boolean;
  status: string;
  staff?: { fullName: string; staffId: string };
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
  rows: { date: string; hours: number; isHoliday: boolean; rateValue: number | null; cost: number | null }[];
}

export interface DashboardRow {
  staffId: string;
  staffCode: string;
  fullName: string;
  totalHours: number;
  totalCost: number;
}

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

export const overtimeApi = {
  submit: (input: { date: string; hours: number; reason: string; notes?: string; isHoliday?: boolean }) =>
    api.post<OvertimeRequestRow>("/api/overtime", input),
  list: () => api.get<OvertimeRequestRow[]>("/api/overtime"),
  review: (id: string, decision: "APPROVE" | "REJECT") => api.patch(`/api/overtime/${id}`, { decision }),
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
  dashboard: (month: number, year: number, departmentId?: string) => {
    const params = new URLSearchParams({ month: String(month), year: String(year), ...(departmentId ? { departmentId } : {}) });
    return api.get<DashboardRow[]>(`/api/overtime/dashboard?${params.toString()}`);
  },
};
