import { PunchType } from "@hr/shared";
import { env } from "../../lib/env";

export interface DayTimesheet {
  date: string;
  firstIn: string | null;
  lastOut: string | null;
  hoursWorked: number;
  lateArrival: boolean;
  earlyDeparture: boolean;
  overtimeHours: number;
}

function parseShiftTime(dayDate: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(dayDate);
  d.setHours(h, m, 0, 0);
  return d;
}

/** Pairs chronological IN/OUT punches per calendar day into worked sessions,
 * and flags late arrival / early departure / overtime against the standard
 * shift window in env.ts. Unpaired trailing IN punches (still clocked in,
 * or a missed OUT) are ignored for hours but don't crash the calculation.
 *
 * `punchType` is typed as a plain string (not @hr/shared's PunchType) because
 * callers pass Prisma query results — Prisma generates its own nominally
 * distinct enum type with identical string values, so comparing by value
 * here avoids a needless cast at every call site. */
export function buildTimesheet(
  entries: { timestamp: Date; punchType: string }[]
): DayTimesheet[] {
  const byDay = new Map<string, { timestamp: Date; punchType: string }[]>();
  for (const e of entries) {
    const key = e.timestamp.toISOString().slice(0, 10);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(e);
  }

  const days: DayTimesheet[] = [];
  for (const [date, dayEntries] of [...byDay.entries()].sort()) {
    const sorted = [...dayEntries].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    let hoursWorked = 0;
    let openIn: Date | null = null;
    let firstIn: Date | null = null;
    let lastOut: Date | null = null;

    for (const punch of sorted) {
      if (punch.punchType === PunchType.IN) {
        if (!firstIn) firstIn = punch.timestamp;
        openIn = punch.timestamp;
      } else if (punch.punchType === PunchType.OUT && openIn) {
        hoursWorked += (punch.timestamp.getTime() - openIn.getTime()) / 3600000;
        lastOut = punch.timestamp;
        openIn = null;
      }
    }

    const shiftStart = parseShiftTime(sorted[0].timestamp, env.shiftStart);
    const shiftEnd = parseShiftTime(sorted[0].timestamp, env.shiftEnd);
    const graceMs = env.gracePeriodMinutes * 60000;

    days.push({
      date,
      firstIn: firstIn ? firstIn.toISOString() : null,
      lastOut: lastOut ? lastOut.toISOString() : null,
      hoursWorked: Math.round(hoursWorked * 100) / 100,
      lateArrival: firstIn ? firstIn.getTime() > shiftStart.getTime() + graceMs : false,
      earlyDeparture: lastOut ? lastOut.getTime() < shiftEnd.getTime() - graceMs : false,
      overtimeHours: Math.max(0, Math.round((hoursWorked - env.standardDailyHours) * 100) / 100),
    });
  }

  return days;
}
