import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Role } from "@hr/shared";
import { useAuth } from "../../lib/AuthContext";
import { staffApi, staffCsvExportUrl } from "../../lib/staffApi";
import type { StaffSummaryRow } from "../../lib/staffApi";
import { StaffDetailView } from "./StaffDetailView";
import { StatusBadge } from "../../components/ui";

export function StaffPage() {
  const { user } = useAuth();

  if (user?.role === Role.STAFF) {
    return <StaffDetailView targetId={user.staffId} />;
  }

  return <StaffDirectory />;
}

function StaffDirectory() {
  const [rows, setRows] = useState<StaffSummaryRow[]>([]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const params: Record<string, string> = {};
      if (q) params.q = q;
      if (status) params.status = status;
      setRows(await staffApi.list(params));
    } catch {
      setError("Failed to load staff directory.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4 mb-4">
        <h1 className="text-xl font-semibold text-slate-800">Staff Directory</h1>
        <a
          href={staffCsvExportUrl({ ...(status ? { status } : {}) })}
          className="text-sm text-brand-600 hover:underline"
        >
          Export CSV
        </a>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          load();
        }}
        className="flex flex-wrap gap-2 mb-4"
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name or staff ID"
          className="border border-slate-300 rounded-md px-3 py-1.5 text-sm"
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="border border-slate-300 rounded-md px-3 py-1.5 text-sm"
        >
          <option value="">All statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="ON_LEAVE">On leave</option>
          <option value="SUSPENDED">Suspended</option>
          <option value="RESIGNED">Resigned</option>
          <option value="TERMINATED">Terminated</option>
        </select>
        <button type="submit" className="bg-slate-800 text-white text-sm px-3 py-1.5 rounded-md">
          Filter
        </button>
      </form>

      {loading && <p className="text-slate-500 text-sm">Loading…</p>}
      {error && <p className="text-red-600 text-sm">{error}</p>}

      {!loading && !error && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-500">
              <tr>
                <th className="px-4 py-2">Staff ID</th>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Designation</th>
                <th className="px-4 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2">
                    <Link to={`/staff/${r.id}`} className="text-brand-600 hover:underline">
                      {r.staffId}
                    </Link>
                  </td>
                  <td className="px-4 py-2">{r.fullName}</td>
                  <td className="px-4 py-2">{r.designation}</td>
                  <td className="px-4 py-2"><StatusBadge status={r.status} /></td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                    No staff found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
