import { api, API_URL } from "./api";

export interface StaffSummaryRow {
  id: string;
  staffId: string;
  fullName: string;
  departmentId: string;
  designation: string;
  status: string;
  photoDocumentId: string | null;
}

export interface StaffDetail {
  id: string;
  staffId: string;
  fullName: string;
  nationalId?: string;
  dob: string;
  gender: string;
  contactNumber: string;
  personalEmail: string;
  homeAddress: string;
  emergencyContact: string;
  googleEmail: string;
  role: string;
  departmentId: string;
  designation: string;
  employmentType: string;
  dateJoined: string;
  contractEndDate: string | null;
  status: string;
  photoDocumentId: string | null;
}

export interface EditRequest {
  id: string;
  staffId: string;
  field: string;
  currentValue: string | null;
  requestedValue: string;
  status: string;
  createdAt: string;
}

export interface BankDetail {
  bankName: string;
  accountNumber: string;
  salaryGrade: string;
  basicSalary?: number | null;
  serviceAllowance?: number | null;
  jobAllowance?: number | null;
}

export interface StatusHistoryEntry {
  id: string;
  oldStatus: string | null;
  newStatus: string;
  changedBy: string;
  reason: string | null;
  changedAt: string;
}

export interface Qualification {
  id: string;
  type: string;
  institution: string;
  year: number | null;
  notes: string | null;
}

export interface Department {
  id: string;
  name: string;
}

export const staffApi = {
  list: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    return api.get<StaffSummaryRow[]>(`/api/staff${qs ? `?${qs}` : ""}`);
  },
  departments: () => api.get<Department[]>("/api/staff/departments"),
  getMe: () => api.get<StaffDetail>("/api/staff/me"),
  getById: (id: string) => api.get<StaffDetail | StaffSummaryRow>(`/api/staff/${id}`),
  selfUpdate: (patch: Record<string, string>) => api.patch<StaffDetail>("/api/staff/me", patch),
  adminUpdate: (id: string, patch: Record<string, unknown>) =>
    api.patch<StaffDetail>(`/api/staff/${id}`, patch),
  changeStatus: (id: string, newStatus: string, reason?: string) =>
    api.patch(`/api/staff/${id}/status`, { newStatus, reason }),
  statusHistory: (id: string) => api.get<StatusHistoryEntry[]>(`/api/staff/${id}/status-history`),
  submitEditRequest: (id: string, field: string, requestedValue: string) =>
    api.post<EditRequest>(`/api/staff/${id}/edit-requests`, { field, requestedValue }),
  listEditRequests: () => api.get<EditRequest[]>("/api/staff/edit-requests"),
  reviewEditRequest: (requestId: string, decision: "APPROVED" | "REJECTED") =>
    api.patch(`/api/staff/edit-requests/${requestId}`, { decision }),
  qualifications: (id: string) => api.get<Qualification[]>(`/api/staff/${id}/qualifications`),
  addQualification: (id: string, input: { type: string; institution: string; year?: number; notes?: string }) =>
    api.post(`/api/staff/${id}/qualifications`, input),
  getBankDetails: (id: string) => api.get<BankDetail | null>(`/api/staff/${id}/bank-details`),
  upsertBankDetails: (id: string, input: BankDetail) =>
    api.put<BankDetail>(`/api/staff/${id}/bank-details`, input),
  documents: (id: string) =>
    api.get<{ id: string; docType: string; originalName: string; uploadedAt: string }[]>(
      `/api/staff/${id}/documents`
    ),
};

export async function uploadStaffDocument(staffId: string, file: File, docType: string) {
  const form = new FormData();
  form.append("file", file);
  form.append("docType", docType);
  const res = await fetch(`${API_URL}/api/staff/${staffId}/documents`, {
    method: "POST",
    credentials: "include",
    body: form,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  return res.json();
}

export function staffCsvExportUrl(params: Record<string, string> = {}) {
  const qs = new URLSearchParams({ ...params, format: "csv" }).toString();
  return `${API_URL}/api/staff?${qs}`;
}
