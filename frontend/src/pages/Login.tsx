import { useState } from "react";
import { api, googleLoginUrl } from "../lib/api";
import { useAuth } from "../lib/AuthContext";
import logo from "../assets/kinbidhoo-school-logo.png";

const DEV_BYPASS_ENABLED = import.meta.env.DEV;

export function Login() {
  const { refresh } = useAuth();
  const [staffId, setStaffId] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleDevLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.post("/api/auth/dev-login", { staffId });
      await refresh();
    } catch {
      setError("Dev login failed — check the staff ID exists in seed data, or that DEV_BYPASS_AUTH is enabled on the backend.");
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm bg-white rounded-xl shadow-sm border border-slate-200 p-8 text-center">
        <img src={logo} alt="Kinbidhoo School" className="h-20 w-20 object-contain mx-auto mb-4" />
        <h1 className="text-lg font-semibold text-brand-700">Kinbidhoo School</h1>
        <p className="text-sm text-slate-500 mb-6">HR Management Portal</p>

        <a
          href={googleLoginUrl()}
          className="block w-full rounded-md bg-brand-600 text-white font-medium py-2 hover:bg-brand-700 transition"
        >
          Sign in with Google
        </a>
        <p className="text-xs text-slate-400 mt-2">
          Restricted to Kinbidhoo School Workspace accounts.
        </p>

        {DEV_BYPASS_ENABLED && (
          <form onSubmit={handleDevLogin} className="mt-6 pt-6 border-t border-slate-100 text-left">
            <p className="text-xs font-medium text-slate-500 mb-2">
              Dev-only bypass (local backend must have DEV_BYPASS_AUTH=true)
            </p>
            <input
              type="text"
              placeholder="Seeded staff ID (e.g. KS-0001)"
              value={staffId}
              onChange={(e) => setStaffId(e.target.value)}
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm mb-2"
            />
            <button
              type="submit"
              className="w-full rounded-md bg-slate-800 text-white text-sm py-2 hover:bg-slate-900"
            >
              Dev sign in
            </button>
            {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
          </form>
        )}
      </div>
    </div>
  );
}
