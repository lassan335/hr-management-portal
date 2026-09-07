import { useEffect, useState } from "react";
import { Role } from "@hr/shared";
import { useAuth } from "../../lib/AuthContext";
import { ApiError } from "../../lib/api";
import { overtimeApi } from "../../lib/overtimeApi";
import type { OvertimeRequestRow, MonthlySummary, DashboardRow, LedgerRow } from "../../lib/overtimeApi";
import { Badge, StatusBadge } from "../../components/ui";

const now = new Date();

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

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
      {canReview && <LedgerCard month={month} year={year} />}
    </div>
  );
}

function SubmitAndList() {
  const { user } = useAuth();
  const [list, setList] = useState<OvertimeRequestRow[]>([]);
  const [form, setForm] = useState({
    date: new Date().toISOString().slice(0, 10),
    timeIn: "15:00",
    timeOut: "17:00",
    reason: "",
    isHoliday: false,
  });
  const [error, setError] = useState<string | null>(null);
  const canReview = user?.role === Role.HOD || user?.role === Role.HR_ADMIN;

  async function refresh() {
    setList(await overtimeApi.list());
  }
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit() {
    setError(null);
    try {
      await overtimeApi.submit(form);
      setForm({ ...form, reason: "" });
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to submit request");
    }
  }

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <h2 className="font-medium text-slate-700 mb-2">{canReview ? "Pending Requests" : "My Pre-requested Overtime Slips"}</h2>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="text-left text-slate-500">
            <tr>
              {canReview && <th className="px-2 py-1">Staff</th>}
              <th className="px-2 py-1">Date</th>
              <th className="px-2 py-1">Description</th>
              <th className="px-2 py-1">Time In</th>
              <th className="px-2 py-1">Time Out</th>
              <th className="px-2 py-1">Supervisor</th>
              <th className="px-2 py-1">Approved</th>
              <th className="px-2 py-1">Cancelled</th>
              <th className="px-2 py-1">Work Completed</th>
              <th className="px-2 py-1">Amount</th>
              <th className="px-2 py-1">Actions</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id} className="border-t border-slate-100 align-top">
                {canReview && <td className="px-2 py-1">{r.staff ? `${r.staff.fullName} (${r.staff.staffId})` : ""}</td>}
                <td className="px-2 py-1">{r.date.slice(0, 10)}{r.isHoliday ? " (holiday)" : ""}</td>
                <td className="px-2 py-1">{r.reason}</td>
                <td className="px-2 py-1">{formatTime(r.timeIn)}</td>
                <td className="px-2 py-1">{formatTime(r.timeOut)}</td>
                <td className="px-2 py-1">{r.hodReviewer?.fullName ?? r.hrReviewer?.fullName ?? "—"}</td>
                <td className="px-2 py-1"><StatusBadge status={r.status} /></td>
                <td className="px-2 py-1">{r.cancelled ? <Badge tone="red">Cancelled</Badge> : <Badge tone="slate">No</Badge>}</td>
                <td className="px-2 py-1">{r.workCompleted ? <Badge tone="green">Yes</Badge> : <Badge tone="slate">No</Badge>}</td>
                <td className="px-2 py-1">{r.estimatedCost != null ? `MVR ${r.estimatedCost}` : "—"}</td>
                <td className="px-2 py-1 space-x-2 whitespace-nowrap">
                  {canReview && (r.status === "PENDING_HOD" || r.status === "PENDING_HR") && (
                    <>
                      <button className="text-green-600 text-xs" onClick={async () => { await overtimeApi.review(r.id, "APPROVE"); refresh(); }}>Approve</button>
                      <button className="text-red-600 text-xs" onClick={async () => { await overtimeApi.review(r.id, "REJECT"); refresh(); }}>Reject</button>
                    </>
                  )}
                  {!canReview && !r.cancelled && !r.workCompleted && (
                    <button className="text-red-600 text-xs" onClick={async () => { await overtimeApi.cancel(r.id); refresh(); }}>Cancel</button>
                  )}
                  {!canReview && r.status === "APPROVED" && !r.cancelled && !r.workCompleted && (
                    <button className="text-brand-600 text-xs" onClick={async () => { await overtimeApi.complete(r.id); refresh(); }}>Complete OT Work</button>
                  )}
                </td>
              </tr>
            ))}
            {list.length === 0 && (
              <tr>
                <td colSpan={canReview ? 11 : 10} className="text-slate-400 px-2 py-2">None.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {!canReview && (
        <div className="flex flex-wrap gap-2 items-end border-t border-slate-100 pt-3 mt-3">
          <label className="flex flex-col text-xs">Date
            <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className="border border-slate-300 rounded-md px-2 py-1" />
          </label>
          <label className="flex flex-col text-xs">Time In
            <input type="time" value={form.timeIn} onChange={(e) => setForm({ ...form, timeIn: e.target.value })} className="border border-slate-300 rounded-md px-2 py-1" />
          </label>
          <label className="flex flex-col text-xs">Time Out
            <input type="time" value={form.timeOut} onChange={(e) => setForm({ ...form, timeOut: e.target.value })} className="border border-slate-300 rounded-md px-2 py-1" />
          </label>
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={form.isHoliday} onChange={(e) => setForm({ ...form, isHoliday: e.target.checked })} />
            Holiday
          </label>
          <input placeholder="Reason / task" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} className="border border-slate-300 rounded-md px-2 py-1 text-sm flex-1" />
          <button className="bg-brand-600 text-white text-sm px-3 py-1.5 rounded-md" onClick={submit}>
            Request Overtime
          </button>
        </div>
      )}
      {error && <p className="text-red-600 text-xs mt-2">{error}</p>}
      {!canReview && (
        <p className="text-slate-400 text-xs mt-2">
          Submit before doing the work — requests must be made within the submission window and each slot is capped at a maximum
          continuous duration per the school's overtime policy.
        </p>
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
        <h2 className="font-medium text-slate-700">Monthly Summary (completed work only)</h2>
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
              <li key={i}>
                {r.date.slice(0, 10)}: {formatTime(r.timeIn)}–{formatTime(r.timeOut)} ({r.hours}h
                {r.payableHours !== r.hours ? `, ${r.payableHours}h payable — ${r.hours - r.payableHours}h deducted (catch-up to 8h)` : ""}
                ){r.isHoliday ? " (holiday)" : ""} — rate {r.rateValue ?? "n/a"}, cost {r.cost ?? "n/a"}
              </li>
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
      <div className="flex items-center justify-between mb-2">
        <h2 className="font-medium text-slate-700">Department Dashboard</h2>
        <span className="space-x-3">
          <a href={overtimeApi.reportUrl(month, year, undefined, "excel")} className="text-xs text-brand-600 hover:underline">
            Overtime Report (Excel)
          </a>
          <a href={overtimeApi.reportUrl(month, year, undefined, "pdf")} className="text-xs text-brand-600 hover:underline">
            PDF
          </a>
        </span>
      </div>
      <p className="text-xs text-slate-400 mb-3 border-b border-slate-100 pb-3">
        The report's rate and capping (10% of Basic Salary per staff for normal-day OT, plus a school-wide OT budget
        cap) are computed automatically — see Payroll for setting each staff member's Basic Salary.
      </p>

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

function LedgerCard({ month, year }: { month: number; year: number }) {
  const [rows, setRows] = useState<LedgerRow[]>([]);

  useEffect(() => {
    overtimeApi.ledger(month, year).then(setRows).catch(() => setRows([]));
  }, [month, year]);

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <h2 className="font-medium text-slate-700 mb-2">View and Manage Monthly OT Sheets</h2>
      <p className="text-xs text-slate-400 mb-2">
        One row per completed overtime slot for the OT period (16th of the previous month to the 15th).
      </p>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="text-left text-slate-500">
            <tr>
              <th className="px-2 py-1">Staff</th>
              <th className="px-2 py-1">Date</th>
              <th className="px-2 py-1">Description</th>
              <th className="px-2 py-1">Time In</th>
              <th className="px-2 py-1">Time Out</th>
              <th className="px-2 py-1">Hours</th>
              <th className="px-2 py-1">Holiday</th>
              <th className="px-2 py-1">Rate</th>
              <th className="px-2 py-1">Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-slate-100">
                <td className="px-2 py-1">{r.fullName} ({r.staffCode})</td>
                <td className="px-2 py-1">{r.date.slice(0, 10)}</td>
                <td className="px-2 py-1">{r.description}</td>
                <td className="px-2 py-1">{formatTime(r.timeIn)}</td>
                <td className="px-2 py-1">{formatTime(r.timeOut)}</td>
                <td className="px-2 py-1">{r.hours}</td>
                <td className="px-2 py-1">{r.isHoliday ? "Yes" : "No"}</td>
                <td className="px-2 py-1">{r.rateValue ?? "n/a"}</td>
                <td className="px-2 py-1">{r.cost ?? "n/a"}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="text-slate-400 px-2 py-2">None.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
