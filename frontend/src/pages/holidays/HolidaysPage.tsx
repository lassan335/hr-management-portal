import { useEffect, useState } from "react";
import { Role } from "@hr/shared";
import { useAuth } from "../../lib/AuthContext";
import { holidaysApi } from "../../lib/holidaysApi";
import type { Holiday } from "../../lib/holidaysApi";
import { Card } from "../../components/ui";

function dayLabel(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", { weekday: "short" });
}

export function HolidaysPage() {
  const { user } = useAuth();
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [date, setDate] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
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
      await holidaysApi.create({ date, description });
      setDate("");
      setDescription("");
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
          Every Friday and Saturday counts as a weekend automatically. Add a one-off public holiday here when it falls
          on a weekday — working ≥3h on a holiday makes attendance allowance eligible, ≥8h makes overtime eligible
          (same rule as the weekend).
        </p>
      </div>

      {isHr && (
        <Card className="p-4">
          <h2 className="font-medium text-slate-700 dark:text-slate-200 mb-2">Add a Holiday</h2>
          <div className="flex flex-wrap gap-2 items-end">
            <label className="flex flex-col text-xs">
              Date
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="border border-slate-300 rounded-md px-2 py-1" />
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
                <td colSpan={isHr ? 3 : 2} className="px-2 py-4 text-center text-slate-400 dark:text-slate-500">
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
