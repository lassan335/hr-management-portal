import { useEffect, useState } from "react";
import { Role } from "@hr/shared";
import { useAuth } from "../../lib/AuthContext";
import { ApiError } from "../../lib/api";
import { overtimeApi } from "../../lib/overtimeApi";
import type { OvertimeRequestRow, MonthlySummary, DashboardRow, LedgerRow, SupervisorOption } from "../../lib/overtimeApi";
import { staffApi } from "../../lib/staffApi";
import type { StaffSummaryRow } from "../../lib/staffApi";
import { Badge, StatusBadge } from "../../components/ui";

const now = new Date();

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** 24-hour "HH:mm", independent of locale — what the report-time API expects. */
function toHHmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function completionBadge(r: OvertimeRequestRow) {
  if (!r.workCompleted) {
    return r.status === "APPROVED" ? <Badge tone="slate">Not reported yet</Badge> : <Badge tone="slate">No</Badge>;
  }
  const label = r.completionSource === "MANUAL" ? " (HR)" : r.completionSource === "DEVICE" ? " (Device)" : "";
  return <Badge tone="green">Yes{label}</Badge>;
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
  const [canSupervise, setCanSupervise] = useState(false);
  const [supervisors, setSupervisors] = useState<SupervisorOption[]>([]);
  const [form, setForm] = useState({
    date: new Date().toISOString().slice(0, 10),
    timeIn: "15:00",
    timeOut: "17:00",
    reason: "",
    supervisorId: "",
  });
  const [error, setError] = useState<string | null>(null);
  const isHrAdmin = user?.role === Role.HR_ADMIN;
  // Most real staff (including the actual principal/administrators here)
  // carry plain role STAFF — canSupervise is a separate, HR-set flag, so
  // whether someone can review a request is checked per-row (is THIS
  // request's selectedSupervisorId me?), not a single page-wide gate. Only
  // used here to decide whether to render the review/assign sections at
  // all (an HOD is included for legacy department-routed requests).
  const canAssign = isHrAdmin || canSupervise;
  const canReviewAnything = isHrAdmin || canSupervise || user?.role === Role.HOD;

  useEffect(() => {
    staffApi.getMe().then((me) => setCanSupervise(me.canSupervise)).catch(() => setCanSupervise(false));
    overtimeApi.listSupervisors().then(setSupervisors).catch(() => setSupervisors([]));
  }, []);

  async function refresh() {
    setList(await overtimeApi.list());
  }
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit() {
    setError(null);
    if (!form.supervisorId) {
      setError("Choose a supervisor to review this request.");
      return;
    }
    try {
      await overtimeApi.submit(form);
      setForm({ ...form, reason: "" });
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to submit request");
    }
  }

  // The normal completion path: once approved, the staff member reports
  // the actual time they worked (see the Attendance page for the real
  // punch times) — two prompts, pre-filled with the originally requested
  // times, so hitting OK twice just confirms the estimate was right.
  async function reportTime(r: OvertimeRequestRow) {
    setError(null);
    const timeIn = window.prompt("Actual time IN worked (24-hour HH:mm) — check the Attendance page for your real punch time:", toHHmm(r.timeIn));
    if (timeIn === null) return;
    const timeOut = window.prompt("Actual time OUT worked (24-hour HH:mm):", toHHmm(r.timeOut));
    if (timeOut === null) return;
    try {
      await overtimeApi.reportTime(r.id, { timeIn, timeOut });
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to report time");
    }
  }

  // HR's fallback for when the staff member can't self-report — tries a
  // real device punch first, then a manual override with a reason.
  async function markComplete(id: string) {
    setError(null);
    try {
      await overtimeApi.complete(id);
      refresh();
    } catch (err) {
      if (err instanceof ApiError && err.message === "no_device_confirmation") {
        const note = window.prompt(
          "No time clock punch found for this date yet. Enter a reason to mark it complete manually (Cancel to wait instead):"
        );
        if (note === null) return;
        try {
          await overtimeApi.complete(id, { manual: true, note: note || undefined });
          refresh();
        } catch (err2) {
          setError(err2 instanceof ApiError ? err2.message : "Failed to mark complete");
        }
      } else {
        setError(err instanceof ApiError ? err.message : "Failed to mark complete");
      }
    }
  }

  const assignedToMe = list.filter((r) => r.assignedById && r.staffId === user?.staffId);
  const myRequests = list.filter((r) => !r.assignedById && r.staffId === user?.staffId);
  // Anything in the list that isn't mine is here because the backend
  // scoped it to me specifically — either I'm the selected supervisor, I'm
  // HR_ADMIN, or (legacy requests) I'm the department HOD.
  const pendingMyReview = list.filter((r) => r.staffId !== user?.staffId && (r.status === "PENDING_HOD" || r.status === "PENDING_HR"));
  const awaitingCompletion = isHrAdmin
    ? list.filter((r) => r.staffId !== user?.staffId && r.status === "APPROVED" && !r.cancelled && !r.workCompleted)
    : [];

  return (
    <>
      {assignedToMe.length > 0 && <AssignedToMeTable rows={assignedToMe} onReportTime={reportTime} onCancelled={refresh} setError={setError} />}
      {canReviewAnything && <PendingReviewTable rows={pendingMyReview} onReviewed={refresh} setError={setError} />}
      {isHrAdmin && awaitingCompletion.length > 0 && (
        <AwaitingCompletionTable rows={awaitingCompletion} onMarkComplete={markComplete} />
      )}
      {canAssign && <AssignTaskForm onAssigned={refresh} />}
      <div className="bg-white border border-slate-200 rounded-lg p-4">
      <h2 className="font-medium text-slate-700 mb-2">My Pre-requested Overtime Slips</h2>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="text-left text-slate-500">
            <tr>
              <th className="px-2 py-1">Date</th>
              <th className="px-2 py-1">Description</th>
              <th className="px-2 py-1">Time In</th>
              <th className="px-2 py-1">Time Out</th>
              <th className="px-2 py-1">Supervisor</th>
              <th className="px-2 py-1">Approved</th>
              <th className="px-2 py-1">Cancelled</th>
              <th className="px-2 py-1">Work Reported</th>
              <th className="px-2 py-1">Amount</th>
              <th className="px-2 py-1">Actions</th>
            </tr>
          </thead>
          <tbody>
            {myRequests.map((r) => (
              <tr key={r.id} className="border-t border-slate-100 align-top">
                <td className="px-2 py-1">{r.date.slice(0, 10)}{r.isHoliday ? " (holiday)" : ""}</td>
                <td className="px-2 py-1">{r.reason}</td>
                <td className="px-2 py-1">{formatTime(r.timeIn)}</td>
                <td className="px-2 py-1">{formatTime(r.timeOut)}</td>
                <td className="px-2 py-1">{r.selectedSupervisor?.fullName ?? r.hodReviewer?.fullName ?? r.hrReviewer?.fullName ?? "—"}</td>
                <td className="px-2 py-1"><StatusBadge status={r.status} /></td>
                <td className="px-2 py-1">{r.cancelled ? <Badge tone="red">Cancelled</Badge> : <Badge tone="slate">No</Badge>}</td>
                <td className="px-2 py-1">{completionBadge(r)}</td>
                <td className="px-2 py-1">{r.estimatedCost != null ? `MVR ${r.estimatedCost}` : "—"}</td>
                <td className="px-2 py-1 space-x-2 whitespace-nowrap">
                  {r.status === "APPROVED" && !r.cancelled && !r.workCompleted && (
                    <button className="text-brand-600 text-xs" onClick={() => reportTime(r)}>Report Time Worked</button>
                  )}
                  {!r.cancelled && !r.workCompleted && (
                    <button className="text-red-600 text-xs" onClick={async () => { await overtimeApi.cancel(r.id); refresh(); }}>Cancel</button>
                  )}
                </td>
              </tr>
            ))}
            {myRequests.length === 0 && (
              <tr>
                <td colSpan={10} className="text-slate-400 px-2 py-2">None.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

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
        <label className="flex flex-col text-xs">Supervisor
          <select
            value={form.supervisorId}
            onChange={(e) => setForm({ ...form, supervisorId: e.target.value })}
            className="border border-slate-300 rounded-md px-2 py-1"
          >
            <option value="">Select…</option>
            {supervisors.map((s) => (
              <option key={s.id} value={s.id}>
                {s.fullName} ({s.designation})
              </option>
            ))}
          </select>
        </label>
        <input placeholder="Reason / task" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} className="border border-slate-300 rounded-md px-2 py-1 text-sm flex-1" />
        <button className="bg-brand-600 text-white text-sm px-3 py-1.5 rounded-md" onClick={submit}>
          Request Overtime
        </button>
      </div>
      {error && <p className="text-red-600 text-xs mt-2">{error}</p>}
      <p className="text-slate-400 text-xs mt-2">
        Submit before doing the work — requests must be made within the submission window and each slot is capped at a maximum
        continuous duration per the school's overtime policy. Once your selected supervisor approves it, report the actual time
        you worked (check the Attendance page for your real punch times) — that's what goes into payroll.
      </p>
      </div>
    </>
  );
}

function AssignedToMeTable({
  rows,
  onReportTime,
  onCancelled,
  setError,
}: {
  rows: OvertimeRequestRow[];
  onReportTime: (r: OvertimeRequestRow) => void;
  onCancelled: () => void;
  setError: (msg: string | null) => void;
}) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <h2 className="font-medium text-slate-700 mb-2">Pre Approved Tasks Assigned To Me</h2>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="text-left text-slate-500">
            <tr>
              <th className="px-2 py-1">Date</th>
              <th className="px-2 py-1">Start Time</th>
              <th className="px-2 py-1">End Time</th>
              <th className="px-2 py-1">Description</th>
              <th className="px-2 py-1">Assigned By</th>
              <th className="px-2 py-1">Requested On</th>
              <th className="px-2 py-1">Work Reported</th>
              <th className="px-2 py-1">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-slate-100 align-top">
                <td className="px-2 py-1">{r.date.slice(0, 10)}{r.isHoliday ? " (holiday)" : ""}</td>
                <td className="px-2 py-1">{formatTime(r.timeIn)}</td>
                <td className="px-2 py-1">{formatTime(r.timeOut)}</td>
                <td className="px-2 py-1">{r.reason}</td>
                <td className="px-2 py-1">{r.assignedBy?.fullName ?? "—"}</td>
                <td className="px-2 py-1">{r.createdAt.slice(0, 10)}</td>
                <td className="px-2 py-1">{completionBadge(r)}</td>
                <td className="px-2 py-1 space-x-2 whitespace-nowrap">
                  {!r.cancelled && !r.workCompleted && (
                    <button className="text-brand-600 text-xs" onClick={() => onReportTime(r)}>Report Time Worked</button>
                  )}
                  {!r.cancelled && !r.workCompleted && (
                    <button
                      className="text-red-600 text-xs"
                      onClick={async () => {
                        try {
                          await overtimeApi.cancel(r.id);
                          onCancelled();
                        } catch (e) {
                          setError(e instanceof ApiError ? e.message : "Failed to cancel");
                        }
                      }}
                    >
                      Cancel
                    </button>
                  )}
                  {r.cancelled && <Badge tone="red">Cancelled</Badge>}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="text-slate-400 px-2 py-2">None.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-slate-400 text-xs mt-2">
        Already approved by whoever assigned it — once you've done the work, report the actual time you worked (check the
        Attendance page for your real punch times).
      </p>
    </div>
  );
}

/** Requests awaiting THIS user's approve/reject decision — the backend
 * already scoped listRequests() to only include what's relevant to them
 * (selected supervisor, HR_ADMIN, or a legacy department-HOD match). */
function PendingReviewTable({
  rows,
  onReviewed,
  setError,
}: {
  rows: OvertimeRequestRow[];
  onReviewed: () => void;
  setError: (msg: string | null) => void;
}) {
  async function decide(id: string, decision: "APPROVE" | "REJECT") {
    try {
      await overtimeApi.review(id, decision);
      onReviewed();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to review request");
    }
  }

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <h2 className="font-medium text-slate-700 mb-2">Pending My Review</h2>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="text-left text-slate-500">
            <tr>
              <th className="px-2 py-1">Staff</th>
              <th className="px-2 py-1">Date</th>
              <th className="px-2 py-1">Description</th>
              <th className="px-2 py-1">Time In</th>
              <th className="px-2 py-1">Time Out</th>
              <th className="px-2 py-1">Status</th>
              <th className="px-2 py-1">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-slate-100 align-top">
                <td className="px-2 py-1">{r.staff ? `${r.staff.fullName} (${r.staff.staffId})` : ""}</td>
                <td className="px-2 py-1">{r.date.slice(0, 10)}{r.isHoliday ? " (holiday)" : ""}</td>
                <td className="px-2 py-1">{r.reason}</td>
                <td className="px-2 py-1">{formatTime(r.timeIn)}</td>
                <td className="px-2 py-1">{formatTime(r.timeOut)}</td>
                <td className="px-2 py-1"><StatusBadge status={r.status} /></td>
                <td className="px-2 py-1 space-x-2 whitespace-nowrap">
                  <button className="text-green-600 text-xs" onClick={() => decide(r.id, "APPROVE")}>Approve</button>
                  <button className="text-red-600 text-xs" onClick={() => decide(r.id, "REJECT")}>Reject</button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="text-slate-400 px-2 py-2">None.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** HR_ADMIN's fallback queue — approved requests where the staff member
 * hasn't self-reported their time yet, in case HR needs to intervene
 * (see markComplete in the parent). */
function AwaitingCompletionTable({
  rows,
  onMarkComplete,
}: {
  rows: OvertimeRequestRow[];
  onMarkComplete: (id: string) => void;
}) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <h2 className="font-medium text-slate-700 mb-2">Awaiting Completion (HR override)</h2>
      <p className="text-xs text-slate-400 mb-2">
        Approved requests the staff member hasn't reported their actual time for yet. Normally they'll do this themselves —
        use this only if they can't.
      </p>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="text-left text-slate-500">
            <tr>
              <th className="px-2 py-1">Staff</th>
              <th className="px-2 py-1">Date</th>
              <th className="px-2 py-1">Description</th>
              <th className="px-2 py-1">Requested Time</th>
              <th className="px-2 py-1">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-slate-100 align-top">
                <td className="px-2 py-1">{r.staff ? `${r.staff.fullName} (${r.staff.staffId})` : ""}</td>
                <td className="px-2 py-1">{r.date.slice(0, 10)}</td>
                <td className="px-2 py-1">{r.reason}</td>
                <td className="px-2 py-1">{formatTime(r.timeIn)}–{formatTime(r.timeOut)}</td>
                <td className="px-2 py-1">
                  <button className="text-brand-600 text-xs" onClick={() => onMarkComplete(r.id)}>Mark Complete</button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="text-slate-400 px-2 py-2">None.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AssignTaskForm({ onAssigned }: { onAssigned: () => void }) {
  const [staffList, setStaffList] = useState<StaffSummaryRow[]>([]);
  const [form, setForm] = useState({
    staffId: "",
    date: new Date().toISOString().slice(0, 10),
    timeIn: "18:00",
    timeOut: "22:30",
    reason: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    staffApi.list().then(setStaffList).catch(() => setStaffList([]));
  }, []);

  async function assign() {
    setError(null);
    setStatus(null);
    if (!form.staffId) {
      setError("Choose a staff member.");
      return;
    }
    try {
      await overtimeApi.assign(form);
      setForm({ ...form, reason: "" });
      setStatus("Task assigned.");
      onAssigned();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to assign task");
    }
  }

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <h2 className="font-medium text-slate-700 mb-2">Send New Overtime Work Request Form</h2>
      <div className="flex flex-wrap gap-2 items-end">
        <label className="flex flex-col text-xs">Staff
          <select
            value={form.staffId}
            onChange={(e) => setForm({ ...form, staffId: e.target.value })}
            className="border border-slate-300 rounded-md px-2 py-1"
          >
            <option value="">Select…</option>
            {staffList.map((s) => (
              <option key={s.id} value={s.id}>
                {s.fullName} ({s.staffId})
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-xs">Date
          <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className="border border-slate-300 rounded-md px-2 py-1" />
        </label>
        <label className="flex flex-col text-xs">Start Time
          <input type="time" value={form.timeIn} onChange={(e) => setForm({ ...form, timeIn: e.target.value })} className="border border-slate-300 rounded-md px-2 py-1" />
        </label>
        <label className="flex flex-col text-xs">End Time
          <input type="time" value={form.timeOut} onChange={(e) => setForm({ ...form, timeOut: e.target.value })} className="border border-slate-300 rounded-md px-2 py-1" />
        </label>
        <input placeholder="Description" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} className="border border-slate-300 rounded-md px-2 py-1 text-sm flex-1" />
        <button className="bg-brand-600 text-white text-sm px-3 py-1.5 rounded-md" onClick={assign}>
          Send OT Request
        </button>
      </div>
      <p className="text-slate-400 text-xs mt-2">
        Already pre-approved — the staff member will see this under "Pre Approved Tasks Assigned To Me" and just needs to
        punch OVERTIME IN / OVERTIME OUT on the time clock when they do the work.
      </p>
      {error && <p className="text-red-600 text-xs mt-2">{error}</p>}
      {status && <p className="text-green-600 text-xs mt-2">{status}</p>}
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
          <a href={overtimeApi.individualReportUrl(month, year)} className="text-xs text-brand-600 hover:underline">
            Individual Staff OT Details (Excel)
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
