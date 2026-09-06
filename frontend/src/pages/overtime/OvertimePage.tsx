import { useEffect, useState } from "react";
import { Role } from "@hr/shared";
import { useAuth } from "../../lib/AuthContext";
import { overtimeApi } from "../../lib/overtimeApi";
import type { OvertimeRequestRow, MonthlySummary, DashboardRow } from "../../lib/overtimeApi";

const now = new Date();

export function OvertimePage() {
  const { user } = useAuth();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const canReview = user?.role === Role.HOD || user?.role === Role.HR_ADMIN;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-slate-800">Overtime</h1>

      <div className="flex gap-2 items-end text-sm">
        <label className="flex flex-col">Month
          <input type="number" min={1} max={12} value={month} onChange={(e) => setMonth(Number(e.target.value))} className="border border-slate-300 rounded-md px-2 py-1 w-20" />
        </label>
        <label className="flex flex-col">Year
          <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} className="border border-slate-300 rounded-md px-2 py-1 w-24" />
        </label>
      </div>

      <SubmitAndList />
      <MonthlySummaryCard month={month} year={year} />
      {canReview && <DashboardCard month={month} year={year} />}
    </div>
  );
}

function SubmitAndList() {
  const { user } = useAuth();
  const [list, setList] = useState<OvertimeRequestRow[]>([]);
  const [form, setForm] = useState({ date: new Date().toISOString().slice(0, 10), hours: "1", reason: "", isHoliday: false });
  const canReview = user?.role === Role.HOD || user?.role === Role.HR_ADMIN;

  async function refresh() {
    setList(await overtimeApi.list());
  }
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <h2 className="font-medium text-slate-700 mb-2">{canReview ? "Pending Requests" : "My Overtime Requests"}</h2>
      <ul className="text-sm space-y-1 mb-3">
        {list.map((r) => (
          <li key={r.id} className="flex items-center justify-between">
            <span>
              {r.staff ? `${r.staff.fullName} — ` : ""}{r.date.slice(0, 10)}: {r.hours}h{r.isHoliday ? " (holiday)" : ""} — {r.reason} <em className="text-slate-400">({r.status})</em>
            </span>
            {canReview && (r.status === "PENDING_HOD" || r.status === "PENDING_HR") && (
              <span className="space-x-2">
                <button className="text-green-600 text-xs" onClick={async () => { await overtimeApi.review(r.id, "APPROVE"); refresh(); }}>Approve</button>
                <button className="text-red-600 text-xs" onClick={async () => { await overtimeApi.review(r.id, "REJECT"); refresh(); }}>Reject</button>
              </span>
            )}
          </li>
        ))}
        {list.length === 0 && <li className="text-slate-400">None.</li>}
      </ul>

      {!canReview && (
        <div className="flex flex-wrap gap-2 items-end border-t border-slate-100 pt-3">
          <label className="flex flex-col text-xs">Date
            <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className="border border-slate-300 rounded-md px-2 py-1" />
          </label>
          <label className="flex flex-col text-xs">Hours
            <input type="number" step="0.5" value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} className="border border-slate-300 rounded-md px-2 py-1 w-20" />
          </label>
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={form.isHoliday} onChange={(e) => setForm({ ...form, isHoliday: e.target.checked })} />
            Holiday
          </label>
          <input placeholder="Reason / task" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} className="border border-slate-300 rounded-md px-2 py-1 text-sm flex-1" />
          <button
            className="bg-brand-600 text-white text-sm px-3 py-1.5 rounded-md"
            onClick={async () => {
              await overtimeApi.submit({ date: form.date, hours: Number(form.hours), reason: form.reason, isHoliday: form.isHoliday });
              setForm({ ...form, reason: "" });
              refresh();
            }}
          >
            Submit
          </button>
        </div>
      )}
    </div>
  );
}

function MonthlySummaryCard({ month, year }: { month: number; year: number }) {
  const [summary, setSummary] = useState<MonthlySummary | null>(null);

  useEffect(() => {
    overtimeApi.summary(month, year).then(setSummary).catch(() => setSummary(null));
  }, [month, year]);

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="font-medium text-slate-700">Monthly Summary</h2>
        <span className="space-x-3">
          <a href={overtimeApi.summaryCsvUrl(month, year)} className="text-xs text-brand-600 hover:underline">Export CSV</a>
          <a href={overtimeApi.summaryPdfUrl(month, year)} className="text-xs text-brand-600 hover:underline">Export PDF</a>
        </span>
      </div>
      {summary && (
        <>
          <p className="text-sm text-slate-600 mb-2">Total: {summary.totalHours}h — estimated cost {summary.totalCost}</p>
          <ul className="text-xs text-slate-500 space-y-0.5">
            {summary.rows.map((r, i) => (
              <li key={i}>{r.date.slice(0, 10)}: {r.hours}h{r.isHoliday ? " (holiday)" : ""} — rate {r.rateValue ?? "n/a"}, cost {r.cost ?? "n/a"}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function DashboardCard({ month, year }: { month: number; year: number }) {
  const [rows, setRows] = useState<DashboardRow[]>([]);

  useEffect(() => {
    overtimeApi.dashboard(month, year).then(setRows).catch(() => setRows([]));
  }, [month, year]);

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <h2 className="font-medium text-slate-700 mb-2">Department Dashboard</h2>
      <table className="min-w-full text-sm">
        <thead className="text-left text-slate-500">
          <tr><th className="px-2 py-1">Staff</th><th className="px-2 py-1">Hours</th><th className="px-2 py-1">Cost</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.staffId} className="border-t border-slate-100">
              <td className="px-2 py-1">{r.fullName} ({r.staffCode})</td>
              <td className="px-2 py-1">{r.totalHours}</td>
              <td className="px-2 py-1">{r.totalCost}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
