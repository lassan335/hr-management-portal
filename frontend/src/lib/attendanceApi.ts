import { api, API_URL } from "./api";

export type PunchType = "CHECK_IN" | "CHECK_OUT" | "BREAK_IN" | "BREAK_OUT" | "OVERTIME_IN" | "OVERTIME_OUT";

export interface DayTimesheet {
  date: string;
  firstIn: string | null;
  lastOut: string | null;
  punches: { timestamp: string; punchType: PunchType }[];
  hoursWorked: number;
  breakHours: number;
  otPunchedHours: number;
  lateArrival: boolean;
  earlyDeparture: boolean;
  missingCheckout: boolean;
  overtimeHours: number;
  holidayAttendanceEligible: boolean;
  overtimeEligible: boolean;
}

export interface DashboardRow {
  staffId: string;
  staffCode: string;
  fullName: string;
  totalHours: number;
  lateCount: number;
  earlyDepartureCount: number;
  overtimeHours: number;
}

export interface DailyAttendanceRow {
  staffId: string;
  staffCode: string;
  fullName: string;
  designation: string;
  present: boolean;
  firstIn: string | null;
  lastOut: string | null;
  punches: { timestamp: string; punchType: PunchType }[];
  hoursWorked: number;
  breakHours: number;
  otPunchedHours: number;
  lateArrival: boolean;
  missingCheckout: boolean;
  earlyDeparture: boolean;
  overtimeHours: number;
  isHoliday: boolean;
  holidayType: "GOVERNMENT" | "PUBLIC" | null;
  holidayAttendanceEligible: boolean;
  overtimeEligible: boolean;
}

export interface SyncLogEntry {
  id: string;
  fileName: string;
  processedCount: number;
  matchedCount: number;
  unmatchedCount: number;
  importedAt: string;
}

export interface UnmatchedEntry {
  id: string;
  deviceUserId: string;
  timestamp: string;
  punchType: string;
  syncLog: { fileName: string; importedAt: string };
}

export interface CorrectionRequest {
  id: string;
  staffId: string;
  date: string;
  requestedPunchType: string;
  requestedTime: string;
  reason: string;
  status: string;
  staff?: { fullName: string; staffId: string };
}

export const attendanceApi = {
  clock: (punchType: PunchType) => api.post("/api/attendance/clock", { punchType }),
  timesheet: (from: string, to: string, staffId?: string) => {
    const params = new URLSearchParams({ from, to, ...(staffId ? { staffId } : {}) });
    return api.get<DayTimesheet[]>(`/api/attendance/timesheet?${params.toString()}`);
  },
  timesheetCsvUrl: (from: string, to: string, staffId?: string) => {
    const params = new URLSearchParams({ from, to, format: "csv", ...(staffId ? { staffId } : {}) });
    return `${API_URL}/api/attendance/timesheet?${params.toString()}`;
  },
  timesheetPdfUrl: (from: string, to: string, staffId?: string) => {
    const params = new URLSearchParams({ from, to, format: "pdf", ...(staffId ? { staffId } : {}) });
    return `${API_URL}/api/attendance/timesheet?${params.toString()}`;
  },
  dashboard: (from: string, to: string, departmentId?: string) => {
    const params = new URLSearchParams({ from, to, ...(departmentId ? { departmentId } : {}) });
    return api.get<DashboardRow[]>(`/api/attendance/dashboard?${params.toString()}`);
  },
  /** One row per staff for a single day — HR_ADMIN school-wide, or HOD
   * scoped to their own department. */
  daily: (date: string, departmentId?: string) => {
    const params = new URLSearchParams({ date, ...(departmentId ? { departmentId } : {}) });
    return api.get<DailyAttendanceRow[]>(`/api/attendance/daily?${params.toString()}`);
  },
  /** School-wide attendance report — Excel by default (one row per staff), PDF option. */
  reportUrl: (from: string, to: string, departmentId: string | undefined, format: "excel" | "pdf" = "excel") => {
    const params = new URLSearchParams({ from, to, format, ...(departmentId ? { departmentId } : {}) });
    return `${API_URL}/api/attendance/report?${params.toString()}`;
  },
  /** Attendance Eligible List — day-by-day non-working-day/holiday matrix
   * for the OT pay period (16th-15th), Excel only. */
  eligibleListUrl: (month: number, year: number, departmentId?: string) => {
    const params = new URLSearchParams({ month: String(month), year: String(year), ...(departmentId ? { departmentId } : {}) });
    return `${API_URL}/api/attendance/eligible-list?${params.toString()}`;
  },
  syncLogs: () => api.get<SyncLogEntry[]>("/api/attendance/sync-log"),
  unmatched: () => api.get<UnmatchedEntry[]>("/api/attendance/unmatched"),
  resolveUnmatched: (deviceUserId: string, staffId: string) =>
    api.post(`/api/attendance/unmatched/${deviceUserId}/resolve`, { staffId }),
  corrections: () => api.get<CorrectionRequest[]>("/api/attendance/corrections"),
  submitCorrection: (input: { date: string; requestedPunchType: string; requestedTime: string; reason: string }) =>
    api.post("/api/attendance/corrections", input),
  reviewCorrection: (id: string, decision: "APPROVE" | "REJECT") =>
    api.patch(`/api/attendance/corrections/${id}`, { decision }),
};

export async function uploadZktimeFile(file: File) {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${API_URL}/api/attendance/import`, {
    method: "POST",
    credentials: "include",
    body: form,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  return res.json();
}
