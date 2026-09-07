import { useEffect, useState } from "react";
import { Role } from "@hr/shared";
import { useAuth } from "../../lib/AuthContext";
import { payrollApi } from "../../lib/payrollApi";
import type { PayrollReadyStaff, Adjustment, SalarySlip } from "../../lib/payrollApi";
import { staffApi } from "../../lib/staffApi";
import type { Department } from "../../lib/staffApi";
import { Card } from "../../components/ui";

const now = new Date();

function mvr(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function PayrollPage() {
  const { user } = useAuth();
  if (!user) return null;
  // Admin-only data fetching lives inside AdminPayrollView so those hooks
  // never run (and never 403) when a non-admin renders MySalarySlip instead.
  if (user.role !== Role.HR_ADMIN) return <MySalarySlip staffId={user.staffId} />;
  return <AdminPayrollView />;
}

function AdminPayrollView() {
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [departmentId, setDepartmentId] = useState("");
  const [departments, setDepartments] = useState<Department[]>([]);
  const [staff, setStaff] = useState<PayrollReadyStaff[]>([]);
  const [selected, setSelected] = useState<PayrollReadyStaff | null>(null);

  useEffect(() => {
    staffApi.departments().then(setDepartments).catch(() => setDepartments([]));
  }, []);

  useEffect(() => {
    payrollApi
      .ready(departmentId || undefined)
      .then((rows) => {
        setStaff(rows);
        setSelected((s) => (s && rows.find((r) => r.id === s.id) ? s : null));
      })
      .catch(() => setStaff([]));
  }, [departmentId]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-800 dark:text-slate-100">Payroll</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Salary slips for staff with basic salary configured (Staff Directory → profile → Bank &amp; payroll).
        </p>
      </div>

      <div className="flex flex-wrap gap-2 items-end text-sm">
        <label className="flex flex-col">
          Month
          <input type="number" min={1} max={12} value={month} onChange={(e) => setMonth(Number(e.target.value))} className="border border-slate-300 rounded-md px-2 py-1 w-20" />
        </label>
        <label className="flex flex-col">
          Year
          <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} className="border border-slate-300 rounded-md px-2 py-1 w-24" />
        </label>
        <label className="flex flex-col">
          Department
          <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className="border border-slate-300 rounded-md px-2 py-1">
            <option value="">All departments</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </label>
        <a
          href={payrollApi.bulkUrl(month, year, departmentId || undefined, "excel")}
          className="bg-brand-600 text-white text-sm px-4 py-2 rounded-md hover:bg-brand-700"
        >
          Generate Salary Sheet (Excel)
        </a>
        <a
          href={payrollApi.bulkUrl(month, year, departmentId || undefined, "pdf")}
          className="border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 text-sm px-4 py-2 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800"
        >
          PDF instead
        </a>
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        <Card className="p-4 md:col-span-1">
          <h2 className="font-medium text-slate-700 dark:text-slate-200 mb-2">Staff with payroll configured</h2>
          <ul className="text-sm divide-y divide-slate-100 dark:divide-slate-800 max-h-[28rem] overflow-y-auto">
            {staff.map((s) => (
              <li key={s.id}>
                <button
                  onClick={() => setSelected(s)}
                  className={`w-full text-left px-2 py-2 rounded-md ${
                    selected?.id === s.id ? "bg-brand-50 dark:bg-slate-800 text-brand-700 dark:text-white" : "hover:bg-slate-50 dark:hover:bg-slate-800/60"
                  }`}
                >
                  <p className="font-medium">{s.fullName}</p>
                  <p className="text-xs text-slate-400">{s.staffId} · {s.designation}</p>
                </button>
              </li>
            ))}
            {staff.length === 0 && <li className="text-slate-400 px-2 py-4">No staff have payroll figures configured yet.</li>}
          </ul>
        </Card>

        <div className="md:col-span-2">
          {selected ? (
            <SlipEditor key={`${selected.id}-${month}-${year}`} staff={selected} month={month} year={year} />
          ) : (
            <Card className="p-8 text-center text-slate-400 dark:text-slate-500 text-sm">
              Select a staff member to view and generate their salary slip.
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function SlipEditor({ staff, month, year }: { staff: PayrollReadyStaff; month: number; year: number }) {
  const [adjustment, setAdjustment] = useState<Adjustment>({
    mibDeduction: 0,
    otherDeduction: 0,
    absentDeduction: 0,
    attendanceAllowancePerDay: 0,
  });
  const [slip, setSlip] = useState<SalarySlip | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setError(null);
    try {
      const [adj, s] = await Promise.all([
        payrollApi.getAdjustment(staff.id, month, year),
        payrollApi.slip(staff.id, month, year),
      ]);
      setAdjustment(adj);
      setSlip(s);
    } catch (e) {
      setError((e as Error).message || "Failed to load salary slip.");
      setSlip(null);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staff.id, month, year]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await payrollApi.saveAdjustment(staff.id, { month, year, ...adjustment });
      await refresh();
    } catch (e) {
      setError((e as Error).message || "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-medium text-slate-700 dark:text-slate-200">
            {staff.fullName} <span className="text-slate-400 font-normal">({staff.staffId})</span>
          </h2>
          <span className="space-x-2">
            <a
              href={payrollApi.slipExcelUrl(staff.id, month, year)}
              className="text-xs bg-brand-600 text-white px-3 py-1.5 rounded-md hover:bg-brand-700"
            >
              Download Excel
            </a>
            <a
              href={payrollApi.slipPdfUrl(staff.id, month, year)}
              className="text-xs border border-slate-300 dark:border-slate-700 px-3 py-1.5 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              PDF
            </a>
          </span>
        </div>

        <p className="text-xs text-slate-400 mb-3">
          Payable days, late deduction, overtime allowance, and pension (7% of basic) are computed automatically from
          attendance/leave/overtime data. Fill in what isn't tracked elsewhere:
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {(
            [
              ["mibDeduction", "MIB Deduction"],
              ["otherDeduction", "Other Deduction"],
              ["absentDeduction", "Absent Deduction"],
              ["attendanceAllowancePerDay", "Attendance Allowance / day"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex flex-col text-xs">
              {label}
              <input
                type="number"
                min={0}
                step="0.01"
                value={adjustment[key]}
                onChange={(e) => setAdjustment({ ...adjustment, [key]: e.target.value })}
                className="border border-slate-300 rounded-md px-2 py-1 text-sm"
              />
            </label>
          ))}
        </div>
        <button
          disabled={saving}
          onClick={save}
          className="mt-3 bg-slate-800 text-white text-sm px-3 py-1.5 rounded-md disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save & Recalculate"}
        </button>
        {error && <p className="text-red-600 text-xs mt-2">{error}</p>}
      </Card>

      {slip && <SlipTable slip={slip} />}
    </div>
  );
}

/** Read-only "My Salary Slip" view for Staff/HOD — no adjustment editing
 * (that stays HR-only), just their own computed slip and a download link. */
function MySalarySlip({ staffId }: { staffId: string }) {
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [slip, setSlip] = useState<SalarySlip | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    payrollApi
      .slip(staffId, month, year)
      .then(setSlip)
      .catch((e: Error) => {
        setSlip(null);
        setError(e.message === "payroll_not_configured" ? "Payroll hasn't been set up for you yet — ask HR." : e.message || "Failed to load.");
      });
  }, [staffId, month, year]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-800 dark:text-slate-100">My Salary Slip</h1>
      </div>

      <div className="flex flex-wrap gap-2 items-end text-sm">
        <label className="flex flex-col">
          Month
          <input type="number" min={1} max={12} value={month} onChange={(e) => setMonth(Number(e.target.value))} className="border border-slate-300 rounded-md px-2 py-1 w-20" />
        </label>
        <label className="flex flex-col">
          Year
          <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} className="border border-slate-300 rounded-md px-2 py-1 w-24" />
        </label>
        {slip && (
          <>
            <a
              href={payrollApi.slipExcelUrl(staffId, month, year)}
              className="bg-brand-600 text-white text-sm px-4 py-2 rounded-md hover:bg-brand-700"
            >
              Download Excel
            </a>
            <a
              href={payrollApi.slipPdfUrl(staffId, month, year)}
              className="border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 text-sm px-4 py-2 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              Download PDF
            </a>
          </>
        )}
      </div>

      {error && <p className="text-red-600 text-sm">{error}</p>}
      {slip && <SlipTable slip={slip} />}
    </div>
  );
}

function SlipTable({ slip }: { slip: SalarySlip }) {
  return (
    <Card className="p-4">
      <h3 className="font-medium text-slate-700 dark:text-slate-200 mb-1">SALARY PARTICULARS - {slip.periodLabel}</h3>
      <p className="text-xs text-slate-400 mb-3">
        Period: {slip.periodFrom} to {slip.periodTo}
      </p>
      <table className="w-full text-sm">
        <tbody>
          <SlipRow label="Basic Salary" value={mvr(slip.basicSalary)} />
          <SlipRow label="Payable Days" value={`${slip.payableDays} / ${slip.daysInPeriod}`} />
          <SlipRow label="Deducted Late" value={mvr(slip.lateDeduction)} />
          <SlipRow label="Deducted Absent" value={mvr(slip.absentDeduction)} />
          <SlipRow label="Deducted From Service Allowance" value={mvr(slip.serviceDeduction)} />
          <SlipRow label="Deducted From Job Allowance" value={mvr(slip.jobDeduction)} />
          <SlipRow label="Salary After Late/Absent Deduction" value={mvr(slip.salaryAfterLateAbsent)} bold />
          <SlipRow label="Deducted MIB" value={mvr(slip.mibDeduction)} />
          <SlipRow label="Deducted Pension Scheme (7%)" value={mvr(slip.pensionDeduction)} />
          <SlipRow label="Deducted Others" value={mvr(slip.otherDeduction)} />
          <SlipRow label="Total Other Deduction" value={mvr(slip.totalOtherDeduction)} bold />
          <SlipRow label="Overtime Allowance" value={mvr(slip.overtimeAllowance)} />
          <SlipRow label="Attendance Allowance" value={mvr(slip.attendanceAllowance)} />
          <SlipRow label="Attendance Allowance Days" value={String(slip.daysPresent)} />
          <SlipRow label="Job Allowance" value={mvr(slip.jobAllowanceNet)} />
          <SlipRow label="Total Income" value={mvr(slip.totalIncome)} bold />
          <SlipRow label="Net Pay" value={mvr(slip.netPay)} bold />
        </tbody>
      </table>
    </Card>
  );
}

function SlipRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <tr className={`border-t border-slate-100 dark:border-slate-800 ${bold ? "font-semibold bg-slate-50 dark:bg-slate-800/60" : ""}`}>
      <td className="px-2 py-1.5">{label}</td>
      <td className="px-2 py-1.5 text-right">{value}</td>
    </tr>
  );
}
