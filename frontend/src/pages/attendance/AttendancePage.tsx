import { useEffect, useState } from "react";
import { Role } from "@hr/shared";
import { useAuth } from "../../lib/AuthContext";
import { attendanceApi, uploadZktimeFile } from "../../lib/attendanceApi";
import type {
  DayTimesheet,
  DashboardRow,
  SyncLogEntry,
  UnmatchedEntry,
  CorrectionRequest,
} from "../../lib/attendanceApi";
import { Badge, StatusBadge } from "../../components/ui";

function firstOfMonth(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function AttendancePage() {
  const { user } = useAuth();
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(today());

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-slate-800">Time Clock &amp; Attendance</h1>

      <div className="flex gap-2 items-end text-sm">
        <label className="flex flex-col">
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="border border-slate-300 rounded-md px-2 py-1" />
        </label>
        <label className="flex flex-col">
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="border border-slate-300 rounded-md px-2 py-1" />
        </label>
      </div>

      <ClockCard />
      <MyTimesheet from={from} to={to} />

      {(user?.role === Role.HOD || user?.role === Role.HR_ADMIN) && <DepartmentDashboard from={from} to={to} />}
      <CorrectionsSection />
      {user?.role === Role.HR_ADMIN && <ZktimeImportSection />}
    </div>
  );
}

function ClockCard() {
  const [message, setMessage] = useState<string | null>(null);

  async function punch(punchType?: "IN" | "OUT") {
    const entry = await attendanceApi.clock(punchType) as { punchType: string; timestamp: string };
    setMessage(`Clocked ${entry.punchType} at ${new Date(entry.timestamp).toLocaleTimeString()}.`);
  }

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4 flex items-center gap-3">
      <button onClick={() => punch("IN")} className="bg-brand-600 text-white text-sm px-4 py-2 rounded-md">Clock In</button>
      <button onClick={() => punch("OUT")} className="bg-slate-800 text-white text-sm px-4 py-2 rounded-md">Clock Out</button>
      {message && <span className="text-sm text-slate-500">{message}</span>}
    </div>
  );
}

function MyTimesheet({ from, to }: { from: string; to: string }) {
  const [days, setDays] = useState<DayTimesheet[]>([]);

  useEffect(() => {
    attendanceApi.timesheet(from, to).then(setDays).catch(() => setDays([]));
  }, [from, to]);

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="font-medium text-slate-700">My Timesheet</h2>
        <span className="space-x-3">
          <a href={attendanceApi.timesheetCsvUrl(from, to)} className="text-xs text-brand-600 hover:underline">Export CSV</a>
          <a href={attendanceApi.timesheetPdfUrl(from, to)} className="text-xs text-brand-600 hover:underline">Export PDF</a>
        </span>
      </div>
      <TimesheetTable days={days} />
    </div>
  );
}

function TimesheetTable({ days }: { days: DayTimesheet[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="text-left text-slate-500">
          <tr>
            <th className="px-2 py-1">Date</th>
            <th className="px-2 py-1">First In</th>
            <th className="px-2 py-1">Last Out</th>
            <th className="px-2 py-1">Hours</th>
            <th className="px-2 py-1">Flags</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.date} className="border-t border-slate-100">
              <td className="px-2 py-1">{d.date}</td>
              <td className="px-2 py-1">{d.firstIn ? new Date(d.firstIn).toLocaleTimeString() : "—"}</td>
              <td className="px-2 py-1">{d.lastOut ? new Date(d.lastOut).toLocaleTimeString() : "—"}</td>
              <td className="px-2 py-1">{d.hoursWorked}</td>
              <td className="px-2 py-1 space-x-1 space-y-1">
                {d.lateArrival && <Badge tone="amber">Late</Badge>}
                {d.earlyDeparture && <Badge tone="amber">Early leave</Badge>}
                {d.overtimeHours > 0 && <Badge tone="blue">+{d.overtimeHours}h OT</Badge>}
                {d.holidayAttendanceEligible && <Badge tone="green">Holiday attendance eligible</Badge>}
                {d.overtimeEligible && <Badge tone="green">Overtime eligible</Badge>}
              </td>
            </tr>
          ))}
          {days.length === 0 && (
            <tr><td colSpan={5} className="px-2 py-4 text-center text-slate-400">No entries in range.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function DepartmentDashboard({ from, to }: { from: string; to: string }) {
  const [rows, setRows] = useState<DashboardRow[]>([]);

  useEffect(() => {
    attendanceApi.dashboard(from, to).then(setRows).catch(() => setRows([]));
  }, [from, to]);

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <h2 className="font-medium text-slate-700 mb-2">Department Dashboard</h2>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="text-left text-slate-500">
            <tr>
              <th className="px-2 py-1">Staff</th>
              <th className="px-2 py-1">Total Hours</th>
              <th className="px-2 py-1">Late</th>
              <th className="px-2 py-1">Early Leave</th>
              <th className="px-2 py-1">Overtime</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.staffId} className="border-t border-slate-100">
                <td className="px-2 py-1">{r.fullName} ({r.staffCode})</td>
                <td className="px-2 py-1">{r.totalHours}</td>
                <td className="px-2 py-1">{r.lateCount}</td>
                <td className="px-2 py-1">{r.earlyDepartureCount}</td>
                <td className="px-2 py-1">{r.overtimeHours}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CorrectionsSection() {
  const { user } = useAuth();
  const [list, setList] = useState<CorrectionRequest[]>([]);
  const [form, setForm] = useState({ date: today(), requestedPunchType: "IN", requestedTime: "", reason: "" });
  const canReview = user?.role === Role.HOD || user?.role === Role.HR_ADMIN;

  async function refresh() {
    setList(await attendanceApi.corrections());
  }
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <h2 className="font-medium text-slate-700 mb-2">Attendance Correction Requests</h2>
      <ul className="text-sm space-y-1 mb-3">
        {list.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-2">
            <span>
              {c.staff ? `${c.staff.fullName} — ` : ""}{c.date.slice(0, 10)} {c.requestedPunchType} @{" "}
              {new Date(c.requestedTime).toLocaleTimeString()} — {c.reason}
            </span>
            <StatusBadge status={c.status} />
            {canReview && (c.status === "PENDING_HOD" || c.status === "PENDING_HR") && (
              <span className="space-x-2">
                <button className="text-green-600 text-xs" onClick={async () => { await attendanceApi.reviewCorrection(c.id, "APPROVE"); refresh(); }}>Approve</button>
                <button className="text-red-600 text-xs" onClick={async () => { await attendanceApi.reviewCorrection(c.id, "REJECT"); refresh(); }}>Reject</button>
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
          <label className="flex flex-col text-xs">Type
            <select value={form.requestedPunchType} onChange={(e) => setForm({ ...form, requestedPunchType: e.target.value })} className="border border-slate-300 rounded-md px-2 py-1">
              <option value="IN">IN</option>
              <option value="OUT">OUT</option>
            </select>
          </label>
          <label className="flex flex-col text-xs">Time
            <input type="datetime-local" value={form.requestedTime} onChange={(e) => setForm({ ...form, requestedTime: e.target.value })} className="border border-slate-300 rounded-md px-2 py-1" />
          </label>
          <input placeholder="Reason" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} className="border border-slate-300 rounded-md px-2 py-1 text-sm flex-1" />
          <button
            className="bg-brand-600 text-white text-sm px-3 py-1.5 rounded-md"
            onClick={async () => {
              await attendanceApi.submitCorrection({
                date: form.date,
                requestedPunchType: form.requestedPunchType,
                requestedTime: new Date(form.requestedTime).toISOString(),
                reason: form.reason,
              });
              setForm({ ...form, reason: "", requestedTime: "" });
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

function ZktimeImportSection() {
  const [logs, setLogs] = useState<SyncLogEntry[]>([]);
  const [unmatched, setUnmatched] = useState<UnmatchedEntry[]>([]);
  const [resolveTargets, setResolveTargets] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);

  async function refresh() {
    setLogs(await attendanceApi.syncLogs());
    setUnmatched(await attendanceApi.unmatched());
  }
  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <h2 className="font-medium text-slate-700 mb-2">Attendance Import (ZKTime 5.0)</h2>
      <p className="text-xs text-slate-500 mb-2">
        Upload a CSV/Excel export from ZKTime 5.0, or drop it into the watched folder
        (<code>backend/import-watch/incoming</code>) for automatic pickup.
      </p>
      <input
        type="file"
        accept=".csv,.xlsx,.xls"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          setStatus("Importing…");
          try {
            const result = await uploadZktimeFile(file) as { processedCount: number; matchedCount: number; unmatchedCount: number };
            setStatus(`Imported: ${result.processedCount} processed, ${result.matchedCount} matched, ${result.unmatchedCount} unmatched.`);
            refresh();
          } catch (err) {
            setStatus((err as Error).message);
          }
        }}
        className="text-sm mb-3"
      />
      {status && <p className="text-sm text-slate-600 mb-3">{status}</p>}

      <h3 className="text-sm font-medium text-slate-600 mb-1">Import History</h3>
      <ul className="text-xs text-slate-500 mb-4 space-y-0.5">
        {logs.map((l) => (
          <li key={l.id}>
            {new Date(l.importedAt).toLocaleString()} — {l.fileName}: {l.processedCount} processed, {l.matchedCount} matched, {l.unmatchedCount} unmatched
          </li>
        ))}
        {logs.length === 0 && <li>No imports yet.</li>}
      </ul>

      <h3 className="text-sm font-medium text-slate-600 mb-1">Unmatched Device IDs</h3>
      <ul className="text-sm space-y-2">
        {unmatched.map((u) => (
          <li key={u.id} className="flex items-center gap-2">
            <span className="flex-1">
              Device ID <strong>{u.deviceUserId}</strong> — {new Date(u.timestamp).toLocaleString()} ({u.punchType}) from {u.syncLog.fileName}
            </span>
            <input
              placeholder="Staff ID to link"
              value={resolveTargets[u.deviceUserId] ?? ""}
              onChange={(e) => setResolveTargets({ ...resolveTargets, [u.deviceUserId]: e.target.value })}
              className="border border-slate-300 rounded-md px-2 py-1 text-xs w-32"
            />
            <button
              className="text-xs bg-brand-600 text-white px-2 py-1 rounded-md"
              onClick={async () => {
                const staffId = resolveTargets[u.deviceUserId];
                if (!staffId) return;
                await attendanceApi.resolveUnmatched(u.deviceUserId, staffId);
                refresh();
              }}
            >
              Link
            </button>
          </li>
        ))}
        {unmatched.length === 0 && <li className="text-slate-400">None outstanding.</li>}
      </ul>
    </div>
  );
}
