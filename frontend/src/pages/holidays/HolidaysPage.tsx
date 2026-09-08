import { useEffect, useState } from "react";
import { Role } from "@hr/shared";
import { useAuth } from "../../lib/AuthContext";
import { holidaysApi } from "../../lib/holidaysApi";
import type { Holiday, HolidayScope, HolidayType } from "../../lib/holidaysApi";
import { Card, Badge } from "../../components/ui";

function dayLabel(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", { weekday: "short" });
}

const SCOPE_BADGE: Record<HolidayScope, { label: string; tone: "red" | "green" | "amber" }> = {
  ALL: { label: "Public Holiday", tone: "red" },
  TEACHING: { label: "Teachers Only", tone: "green" },
  NON_TEACHING: { label: "Admin Staff Only", tone: "amber" },
};

const TYPE_BADGE: Record<HolidayType, { label: string; tone: "blue" | "slate" }> = {
  GOVERNMENT: { label: "Government (normal rate)", tone: "slate" },
  PUBLIC: { label: "Public (elevated rate)", tone: "blue" },
};

export function HolidaysPage() {
  const { user } = useAuth();
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [date, setDate] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<HolidayScope>("ALL");
  const [type, setType] = useState<HolidayType>("PUBLIC");
  const [error, setError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const isHr = user?.role === Role.HR_ADMIN;

  async function refresh() {
    setHolidays(await holidaysApi.list());
  }
  useEffect(() => {
    refresh();
  }, []);

  async function add() {
    setError(null);
    if (!date || !description) return setError("Date and description are required.");
    try {
      await holidaysApi.create({ date, description, scope, type });
      setDate("");
      setDescription("");
      setScope("ALL");
      setType("PUBLIC");
      setShowAddForm(false);
      refresh();
    } catch (e) {
      setError((e as Error).message || "Failed to add holiday.");
    }
  }

  async function remove(id: string) {
    await holidaysApi.remove(id);
    refresh();
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-800 dark:text-slate-100">Public Holidays / Non-Working Days</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Every Sunday–Thursday is a working day. Friday counts as a Public Holiday and Saturday as a Government
          Holiday automatically. "Applies to" controls who gets the day off (everyone, or just Teachers / Admin
          Staff); "Type" controls the pay rule: a Government Holiday uses the normal overtime rate and the usual
          hours-worked threshold before overtime kicks in, while a Public Holiday pays the elevated overtime rate and
          counts overtime from the very first minute worked. Both types make attendance allowance eligible once ≥3h
          is worked.
        </p>
      </div>

      {isHr && !showAddForm && (
        <div className="flex justify-end">
          <button
            onClick={() => setShowAddForm(true)}
            className="bg-brand-600 text-white text-sm px-4 py-1.5 rounded-md hover:bg-brand-700"
          >
            Add A Holiday
          </button>
        </div>
      )}

      {isHr && showAddForm && (
        <Card className="p-4">
          <h2 className="font-medium text-slate-700 dark:text-slate-200 mb-2">Add a Holiday</h2>
          <div className="flex flex-wrap gap-2 items-end">
            <label className="flex flex-col text-xs">
              Date
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="border border-slate-300 rounded-md px-2 py-1" />
            </label>
            <label className="flex flex-col text-xs">
              Applies to
              <select value={scope} onChange={(e) => setScope(e.target.value as HolidayScope)} className="border border-slate-300 rounded-md px-2 py-1">
                <option value="ALL">Everyone</option>
                <option value="TEACHING">Teachers Only</option>
                <option value="NON_TEACHING">Admin Staff Only</option>
              </select>
            </label>
            <label className="flex flex-col text-xs">
              Type
              <select value={type} onChange={(e) => setType(e.target.value as HolidayType)} className="border border-slate-300 rounded-md px-2 py-1">
                <option value="PUBLIC">Public (elevated OT rate)</option>
                <option value="GOVERNMENT">Government (normal OT rate)</option>
              </select>
            </label>
            <input
              placeholder="Description (e.g. New Year)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="border border-slate-300 rounded-md px-2 py-1 text-sm flex-1 min-w-[200px]"
            />
            <button onClick={add} className="bg-brand-600 text-white text-sm px-4 py-1.5 rounded-md hover:bg-brand-700">
              Add
            </button>
            <button
              onClick={() => {
                setShowAddForm(false);
                setError(null);
              }}
              className="text-sm text-slate-500 px-3 py-1.5"
            >
              Cancel
            </button>
          </div>
          {error && <p className="text-red-600 text-xs mt-2">{error}</p>}
        </Card>
      )}

      <Card className="p-4">
        <h2 className="font-medium text-slate-700 dark:text-slate-200 mb-2">Holidays</h2>
        <table className="min-w-full text-sm">
          <thead className="text-left text-slate-500 dark:text-slate-400">
            <tr>
              <th className="px-2 py-1">Date</th>
              <th className="px-2 py-1">Description</th>
              <th className="px-2 py-1">Applies to</th>
              <th className="px-2 py-1">Type</th>
              {isHr && <th className="px-2 py-1"></th>}
            </tr>
          </thead>
          <tbody>
            {holidays.map((h) => (
              <tr key={h.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-2 py-1">
                  {h.date.slice(0, 10)} ({dayLabel(h.date)})
                </td>
                <td className="px-2 py-1">{h.description}</td>
                <td className="px-2 py-1">
                  <Badge tone={SCOPE_BADGE[h.scope].tone}>{SCOPE_BADGE[h.scope].label}</Badge>
                </td>
                <td className="px-2 py-1">
                  <Badge tone={TYPE_BADGE[h.type].tone}>{TYPE_BADGE[h.type].label}</Badge>
                </td>
                {isHr && (
                  <td className="px-2 py-1">
                    <button onClick={() => remove(h.id)} className="text-red-600 text-xs hover:underline">
                      Remove
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {holidays.length === 0 && (
              <tr>
                <td colSpan={isHr ? 5 : 4} className="px-2 py-4 text-center text-slate-400 dark:text-slate-500">
                  No holidays added yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
