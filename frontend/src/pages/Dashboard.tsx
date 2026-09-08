import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Users, UserCheck, Timer, CalendarDays } from "lucide-react";
import { Role } from "@hr/shared";
import { useAuth } from "../lib/AuthContext";
import { staffApi } from "../lib/staffApi";
import type { StaffSummaryRow } from "../lib/staffApi";
import { overtimeApi } from "../lib/overtimeApi";
import type { OvertimeRequestRow } from "../lib/overtimeApi";
import { leaveApi } from "../lib/leaveApi";
import type { LeaveRequestRow } from "../lib/leaveApi";
import { holidaysApi } from "../lib/holidaysApi";
import type { Holiday, HolidayScope } from "../lib/holidaysApi";
import { Card, StatCard, StatusBadge, Badge } from "../components/ui";

export function Dashboard() {
  const { user } = useAuth();
  if (!user) return null;
  if (user.role === Role.HR_ADMIN || user.role === Role.HOD) return <OverviewDashboard />;
  return <StaffDashboard />;
}

const SCOPE_BADGE: Record<HolidayScope, { label: string; tone: "red" | "green" | "amber" }> = {
  ALL: { label: "Public Holiday", tone: "red" },
  TEACHING: { label: "Teachers Only", tone: "green" },
  NON_TEACHING: { label: "Admin Staff Only", tone: "amber" },
};

/** Next upcoming holidays from the academic calendar, filtered to ones that
 * actually apply to the logged-in user (a Public Holiday, or one scoped to
 * their own Teacher/Admin Staff category) — the same rule the timesheet
 * uses, just surfaced here so it's visible without digging into a payslip. */
function UpcomingHolidays() {
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [category, setCategory] = useState<string | null>(null);

  useEffect(() => {
    staffApi.getMe().then((me) => setCategory(me.category)).catch(() => setCategory(null));
    const today = new Date().toISOString().slice(0, 10);
    holidaysApi.list(today).then(setHolidays).catch(() => setHolidays([]));
  }, []);

  const upcoming = holidays.filter((h) => h.scope === "ALL" || h.scope === category).slice(0, 8);

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-medium text-slate-700 dark:text-slate-200">Upcoming Holidays</h2>
        <Link to="/holidays" className="text-xs text-brand-600 dark:text-brand-400 hover:underline">
          View calendar
        </Link>
      </div>
      <div className="space-y-2">
        {upcoming.map((h) => (
          <div key={h.id} className="flex items-center justify-between gap-2 text-sm">
            <div className="min-w-0">
              <p className="text-slate-700 dark:text-slate-200">{h.description}</p>
              <p className="text-xs text-slate-400 dark:text-slate-500">
                {new Date(h.date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
              </p>
            </div>
            <Badge tone={SCOPE_BADGE[h.scope].tone}>{SCOPE_BADGE[h.scope].label}</Badge>
          </div>
        ))}
        {upcoming.length === 0 && <p className="text-sm text-slate-400 dark:text-slate-500">Nothing coming up.</p>}
      </div>
    </Card>
  );
}

function OverviewDashboard() {
  const { user } = useAuth();
  const [staff, setStaff] = useState<StaffSummaryRow[]>([]);
  const [overtime, setOvertime] = useState<OvertimeRequestRow[]>([]);
  const [leave, setLeave] = useState<LeaveRequestRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      staffApi.list().catch(() => []),
      overtimeApi.list().catch(() => []),
      leaveApi.list().catch(() => []),
    ]).then(([s, o, l]) => {
      setStaff(s);
      setOvertime(o);
      setLeave(l);
      setLoading(false);
    });
  }, []);

  const activeCount = staff.filter((s) => s.status === "ACTIVE").length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-800 dark:text-slate-100">
          {user?.role === Role.HR_ADMIN ? "Admin Dashboard" : "Department Dashboard"}
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">Welcome back, {user?.fullName}.</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total Staff" value={loading ? "…" : staff.length} icon={<Users className="h-5 w-5" />} gradient="teal" />
        <StatCard label="Active Staff" value={loading ? "…" : activeCount} icon={<UserCheck className="h-5 w-5" />} gradient="purple" />
        <StatCard label="Pending Overtime" value={loading ? "…" : overtime.length} icon={<Timer className="h-5 w-5" />} gradient="orange" hint="needs review" />
        <StatCard label="Pending Leave" value={loading ? "…" : leave.length} icon={<CalendarDays className="h-5 w-5" />} gradient="pink" hint="needs review" />
      </div>

      <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
        <RecentPanel title="Recent Staff">
          {staff.slice(0, 5).map((s) => (
            <RecentRow key={s.id} primary={s.fullName} secondary={s.designation} status={s.status} />
          ))}
          {staff.length === 0 && <EmptyRow />}
        </RecentPanel>

        <RecentPanel title="Pending Overtime">
          {overtime.slice(0, 5).map((r) => (
            <RecentRow key={r.id} primary={r.staff?.fullName ?? r.staffId} secondary={r.reason} status={r.status} />
          ))}
          {overtime.length === 0 && <EmptyRow />}
        </RecentPanel>

        <RecentPanel title="Pending Leave">
          {leave.slice(0, 5).map((r) => (
            <RecentRow key={r.id} primary={r.staff?.fullName ?? r.staffId} secondary={r.leaveType?.name} status={r.status} />
          ))}
          {leave.length === 0 && <EmptyRow />}
        </RecentPanel>

        <UpcomingHolidays />
      </div>

      <Card>
        <div className="flex items-center justify-between px-4 pt-4">
          <h2 className="font-medium text-slate-700 dark:text-slate-200">Staff Directory</h2>
          <Link to="/staff" className="text-xs text-brand-600 dark:text-brand-400 hover:underline">
            View all
          </Link>
        </div>
        <div className="overflow-x-auto mt-2">
          <table className="min-w-full text-sm">
            <thead className="text-left text-slate-500 dark:text-slate-400">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Staff ID</th>
                <th className="px-4 py-2">Designation</th>
                <th className="px-4 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {staff.slice(0, 8).map((s) => (
                <tr key={s.id} className="border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/40">
                  <td className="px-4 py-2">
                    <Link to={`/staff/${s.id}`} className="text-brand-600 dark:text-brand-400 hover:underline">
                      {s.fullName}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-slate-500 dark:text-slate-400">{s.staffId}</td>
                  <td className="px-4 py-2">{s.designation}</td>
                  <td className="px-4 py-2">
                    <StatusBadge status={s.status} />
                  </td>
                </tr>
              ))}
              {staff.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-slate-400 dark:text-slate-500">
                    No staff found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function StaffDashboard() {
  const { user } = useAuth();
  const [overtime, setOvertime] = useState<OvertimeRequestRow[]>([]);
  const [leave, setLeave] = useState<LeaveRequestRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([overtimeApi.list().catch(() => []), leaveApi.list().catch(() => [])]).then(([o, l]) => {
      setOvertime(o);
      setLeave(l);
      setLoading(false);
    });
  }, []);

  const pendingOvertime = overtime.filter((r) => r.status === "PENDING_HOD" || r.status === "PENDING_HR").length;
  const pendingLeave = leave.filter((r) => r.status === "PENDING_HOD" || r.status === "PENDING_HR").length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-800 dark:text-slate-100">Welcome, {user?.fullName}</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {user?.role} — use the sidebar to reach Staff Directory, Attendance, Overtime, and Leave.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 max-w-md">
        <StatCard label="My Pending Overtime" value={loading ? "…" : pendingOvertime} icon={<Timer className="h-5 w-5" />} gradient="orange" />
        <StatCard label="My Pending Leave" value={loading ? "…" : pendingLeave} icon={<CalendarDays className="h-5 w-5" />} gradient="pink" />
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        <RecentPanel title="My Overtime Requests">
          {overtime.slice(0, 5).map((r) => (
            <RecentRow key={r.id} primary={r.date.slice(0, 10)} secondary={r.reason} status={r.status} />
          ))}
          {overtime.length === 0 && <EmptyRow />}
        </RecentPanel>

        <RecentPanel title="My Leave Requests">
          {leave.slice(0, 5).map((r) => (
            <RecentRow key={r.id} primary={r.leaveType?.name ?? r.leaveTypeId} secondary={`${r.startDate.slice(0, 10)} – ${r.endDate.slice(0, 10)}`} status={r.status} />
          ))}
          {leave.length === 0 && <EmptyRow />}
        </RecentPanel>

        <UpcomingHolidays />
      </div>
    </div>
  );
}

function RecentPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="p-4">
      <h2 className="font-medium text-slate-700 dark:text-slate-200 mb-3">{title}</h2>
      <div className="space-y-2.5">{children}</div>
    </Card>
  );
}

function RecentRow({ primary, secondary, status }: { primary: string; secondary?: string | null; status: string }) {
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <div className="min-w-0">
        <p className="text-slate-700 dark:text-slate-200 truncate">{primary}</p>
        {secondary && <p className="text-xs text-slate-400 dark:text-slate-500 truncate">{secondary}</p>}
      </div>
      <StatusBadge status={status} />
    </div>
  );
}

function EmptyRow() {
  return <p className="text-sm text-slate-400 dark:text-slate-500">Nothing here.</p>;
}
