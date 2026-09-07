// Falls back to whatever host the page itself was loaded from (rather than
// a hardcoded "localhost") so the API call stays same-site as the page —
// e.g. opened via a LAN IP for phone testing, the API call goes to that
// same IP too. A cross-site call (page on localhost, API on a LAN IP, or
// vice versa) makes the login cookie's SameSite=Lax silently drop it on
// every request after the initial POST, breaking auth in a way that's easy
// to misread as "the feature is broken" rather than "the cookie never made
// it back". Set VITE_API_URL explicitly (e.g. for production) to override.
export const API_URL = import.meta.env.VITE_API_URL || `http://${window.location.hostname}:4000`;

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

export function googleLoginUrl(): string {
  return `${API_URL}/api/auth/google`;
}

export function fileUrl(fileId: string): string {
  return `${API_URL}/api/files/${fileId}`;
}
