import { api } from "./api";

export type HolidayScope = "ALL" | "TEACHING" | "NON_TEACHING";
export type HolidayType = "GOVERNMENT" | "PUBLIC";

export interface Holiday {
  id: string;
  date: string;
  description: string;
  scope: HolidayScope;
  type: HolidayType;
  createdAt: string;
}

export const holidaysApi = {
  list: (from?: string, to?: string) => {
    const params = new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) });
    const qs = params.toString();
    return api.get<Holiday[]>(`/api/holidays${qs ? `?${qs}` : ""}`);
  },
  create: (input: { date: string; description: string; scope?: HolidayScope; type?: HolidayType }) =>
    api.post<Holiday>("/api/holidays", input),
  remove: (id: string) => api.delete(`/api/holidays/${id}`),
};
