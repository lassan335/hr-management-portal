import { useEffect, useState } from "react";
import { Role } from "@hr/shared";
import { useAuth } from "../../lib/AuthContext";
import { leaveApi } from "../../lib/leaveApi";
import type { LeaveType, LeaveRequestRow, LeaveBalanceRow, CalendarEntry } from "../../lib/leaveApi";

function firstOfMonth(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}
function endOfMonth(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);
}

export function LeavePage() {
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-slate-800">Leave Management</h1>
      <RequestsSection />
      <MyBalances />
      <CalendarSection />
    </div>
  );
}

function RequestsSection() {
  const { user } = useAuth();
  const [types, setTypes] = useState<LeaveType[]>([]);
  const [list, setList] = useState<LeaveRequestRow[]>([]);
  const [form, setForm] = useState({ leaveTypeId: "", startDate: firstOfMonth(), endDate: firstOfMonth(), reason: "" });
  const [error, setError] = useState<string | null>(null);
  const canReview = user?.role === Role.HOD || user?.role === Role.HR_ADMIN;

  async function refresh() {
    setTypes(await leaveApi.types());
    setList(await leaveApi.list());
  }
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <h2 className="font-medium text-slate-700 mb-2">{canReview ? "Pending Leave Requests" : "My Leave Requests"}</h2>
      <ul className="text-sm space-y-1 mb-3">
        {list.map((r) => (
          <li key={r.id} className="flex items-center justify-between">
            <span>
              {r.staff ? `${r.staff.fullName} — ` : ""}{r.leaveType?.name ?? r.leaveTypeId}: {r.startDate.slice(0, 10)} to {r.endDate.slice(0, 10)}
              {r.reason ? ` — ${r.reason}` : ""} <em className="text-slate-400">({r.status})</em>
            </span>
            {canReview && (r.status === "PENDING_HOD" || r.status === "PENDING_HR") && (
              <span className="space-x-2">
                <button className="text-green-600 text-xs" onClick={async () => { await leaveApi.review(r.id, "APPROVE"); refresh(); }}>Approve</button>
                <button className="text-red-600 text-xs" onClick={async () => { await leaveApi.review(r.id, "REJECT"); refresh(); }}>Reject</button>
              </span>
            )}
          </li>
        ))}
        {list.length === 0 && <li className="text-slate-400">None.</li>}
      </ul>

      {!canReview && (
        <div className="flex flex-wrap gap-2 items-end border-t border-slate-100 pt-3">
          <label className="flex flex-col text-xs">Type
            <select value={form.leaveTypeId} onChange={(e) => setForm({ ...form, leaveTypeId: e.target.value })} className="border border-slate-300 rounded-md px-2 py-1">
              <option value="">Select…</option>
              {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col text-xs">Start
            <input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} className="border border-slate-300 rounded-md px-2 py-1" />
          </label>
          <label className="flex flex-col text-xs">End
            <input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} className="border border-slate-300 rounded-md px-2 py-1" />
          </label>
          <input placeholder="Reason" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} className="border border-slate-300 rounded-md px-2 py-1 text-sm flex-1" />
          <button
            className="bg-brand-600 text-white text-sm px-3 py-1.5 rounded-md"
            onClick={async () => {
              setError(null);
              if (!form.leaveTypeId) return setError("Select a leave type.");
              try {
                await leaveApi.submit(form);
                setForm({ ...form, reason: "" });
                refresh();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Submit
          </button>
        </div>
      )}
      {error && <p className="text-red-600 text-xs mt-2">{error}</p>}
    </div>
  );
}

function MyBalances() {
  const { user } = useAuth();
  const [balances, setBalances] = useState<LeaveBalanceRow[]>([]);

  useEffect(() => {
    if (user) leaveApi.balances(user.staffId).then(setBalances).catch(() => setBalances([]));
  }, [user]);

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <h2 className="font-medium text-slate-700 mb-2">My Leave Balances</h2>
      <table className="min-w-full text-sm">
        <thead className="text-left text-slate-500">
          <tr><th className="px-2 py-1">Type</th><th className="px-2 py-1">Year</th><th className="px-2 py-1">Balance (days)</th></tr>
        </thead>
        <tbody>
          {balances.map((b) => (
            <tr key={b.id} className="border-t border-slate-100">
              <td className="px-2 py-1">{b.leaveType.name}</td>
              <td className="px-2 py-1">{b.year}</td>
              <td className="px-2 py-1">{b.balanceDays}</td>
            </tr>
          ))}
          {balances.length === 0 && <tr><td colSpan={3} className="px-2 py-4 text-center text-slate-400">No balances on file.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function CalendarSection() {
  const [entries, setEntries] = useState<CalendarEntry[]>([]);
  const [from] = useState(firstOfMonth());
  const [to] = useState(endOfMonth());

  useEffect(() => {
    leaveApi.calendar(from, to).then(setEntries).catch(() => setEntries([]));
  }, [from, to]);

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <h2 className="font-medium text-slate-700 mb-2">Department Leave Calendar (this month)</h2>
      <ul className="text-sm space-y-1">
        {entries.map((e) => (
          <li key={e.id}>{e.staff.fullName} — {e.leaveType.name}: {e.startDate.slice(0, 10)} to {e.endDate.slice(0, 10)}</li>
        ))}
        {entries.length === 0 && <li className="text-slate-400">No approved leave this month.</li>}
      </ul>
    </div>
  );
}
