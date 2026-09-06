import { api } from "./api";

export interface LeaveType {
  id: string;
  name: string;
  accrualRule: string | null;
  isCustom: boolean;
}

export interface TermCalendarEntry {
  id: string;
  termName: string;
  startDate: string;
  endDate: string;
  blocksLeave: boolean;
}

export interface LeaveRequestRow {
  id: string;
  staffId: string;
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  reason: string | null;
  status: string;
  staff?: { fullName: string; staffId: string };
  leaveType?: { name: string };
}

export interface LeaveBalanceRow {
  id: string;
  leaveTypeId: string;
  year: number;
  balanceDays: string;
  leaveType: { name: string };
}

export interface CalendarEntry {
  id: string;
  startDate: string;
  endDate: string;
  staff: { fullName: string; staffId: string };
  leaveType: { name: string };
}

export const leaveApi = {
  types: () => api.get<LeaveType[]>("/api/leave/types"),
  createType: (input: { name: string; accrualRule?: string; isCustom?: boolean }) =>
    api.post<LeaveType>("/api/leave/types", input),
  termCalendar: () => api.get<TermCalendarEntry[]>("/api/leave/term-calendar"),
  createTerm: (input: { termName: string; startDate: string; endDate: string; blocksLeave?: boolean }) =>
    api.post<TermCalendarEntry>("/api/leave/term-calendar", input),
  submit: (input: { leaveTypeId: string; startDate: string; endDate: string; reason?: string }) =>
    api.post<LeaveRequestRow>("/api/leave", input),
  list: () => api.get<LeaveRequestRow[]>("/api/leave"),
  review: (id: string, decision: "APPROVE" | "REJECT") => api.patch(`/api/leave/${id}`, { decision }),
  balances: (staffId: string) => api.get<LeaveBalanceRow[]>(`/api/leave/balances/${staffId}`),
  setBalance: (input: { staffId: string; leaveTypeId: string; year: number; balanceDays: number }) =>
    api.post("/api/leave/balances", input),
  history: (staffId: string) => api.get<LeaveRequestRow[]>(`/api/leave/history/${staffId}`),
  calendar: (from: string, to: string, departmentId?: string) => {
    const params = new URLSearchParams({ from, to, ...(departmentId ? { departmentId } : {}) });
    return api.get<CalendarEntry[]>(`/api/leave/calendar?${params.toString()}`);
  },
};
