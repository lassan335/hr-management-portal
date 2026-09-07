import { PunchType } from "@hr/shared";
import { env } from "../../lib/env";

export interface DayTimesheet {
  date: string;
  firstIn: string | null;
  lastOut: string | null;
  hoursWorked: number;
  /** Total time between paired BREAK_IN/BREAK_OUT punches, already excluded
   * from hoursWorked above. */
  breakHours: number;
  /** Total time between paired OVERTIME_IN/OVERTIME_OUT punches — the
   * staff member's ACTUAL clocked overtime, separate from `overtimeHours`
   * below (which is just worked-time-over-standard-hours). Cross-checking
   * the two against an approved OvertimeRequest slot is a further step not
   * implemented here (see README's "Deferred / out of scope"). */
  otPunchedHours: number;
  lateArrival: boolean;
  earlyDeparture: boolean;
  overtimeHours: number;
  /** On a weekend/holiday, attendance counts once >= 3h is worked that day.
   * NOTE: "holiday" here is approximated as Sat/Sun — there's no separate
   * designated-holiday calendar yet (the legacy portal's "Holidays /
   * Non-Working Days" list), so a holiday falling on a weekday isn't
   * detected. Add a Holiday model to close that gap if it matters. */
  holidayAttendanceEligible: boolean;
  /** Uniform 8h/day threshold before any worked time counts as
   * overtime-eligible — distinct from `overtimeHours` above, which is the
   * surplus over this staff member's own group's standard daily hours (may
   * be 6h for some groups). A staff member on a 6h-standard group could
   * show overtimeHours > 0 while still not being "eligible" until 8h. */
  overtimeEligible: boolean;
}

export interface ShiftSettings {
  /** "HH:mm" sign-in time. */
  shiftStart: string;
  /** Standard hours per day — shift end is derived as shiftStart + this. */
  standardDailyHours: number;
}

/** Resolves a staff member's shift settings from their StaffGroup, falling
 * back to env.ts's defaults if they aren't assigned to one. */
export function shiftSettingsFor(staffGroup: { signInTime: string; workingHours: number } | null): ShiftSettings {
  if (staffGroup) {
    return { shiftStart: staffGroup.signInTime, standardDailyHours: staffGroup.workingHours };
  }
  return { shiftStart: env.defaultShiftStart, standardDailyHours: env.defaultStandardDailyHours };
}

function parseShiftTime(dayDate: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(dayDate);
  d.setHours(h, m, 0, 0);
  return d;
}

/** Pairs chronological CHECK_IN/CHECK_OUT punches per calendar day into
 * worked sessions, subtracts any BREAK_IN/BREAK_OUT time from within them,
 * tracks OVERTIME_IN/OVERTIME_OUT as a separate punched-overtime duration,
 * and flags late arrival / early departure / overtime against the given
 * shift window (see shiftSettingsFor — resolved per staff member from their
 * StaffGroup). Unpaired trailing punches (still clocked in, or a missed
 * closing punch) are ignored for hours but don't crash the calculation.
 *
 * BREAK_IN/BREAK_OUT (and similarly OVERTIME_IN/OVERTIME_OUT) are paired by
 * alternation — whichever of the pair appears first opens the interval, the
 * next one of either type closes it — rather than assuming a fixed
 * direction. Real ZKTeco terminals and legacy systems aren't fully
 * consistent about which label means "starting" vs "ending" a break, so
 * this only relies on them alternating within a day, which always holds.
 *
 * `punchType` is typed as a plain string (not @hr/shared's PunchType) because
 * callers pass Prisma query results — Prisma generates its own nominally
 * distinct enum type with identical string values, so comparing by value
 * here avoids a needless cast at every call site. */
export function buildTimesheet(
  entries: { timestamp: Date; punchType: string }[],
  shift: ShiftSettings
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
    let breakHours = 0;
    let otPunchedHours = 0;
    let openIn: Date | null = null;
    let openBreakStart: Date | null = null;
    let openOtStart: Date | null = null;
    let firstIn: Date | null = null;
    let lastOut: Date | null = null;

    for (const punch of sorted) {
      if (punch.punchType === PunchType.CHECK_IN) {
        if (!firstIn) firstIn = punch.timestamp;
        openIn = punch.timestamp;
      } else if (punch.punchType === PunchType.CHECK_OUT && openIn) {
        hoursWorked += (punch.timestamp.getTime() - openIn.getTime()) / 3600000;
        lastOut = punch.timestamp;
        openIn = null;
      } else if (punch.punchType === PunchType.BREAK_IN || punch.punchType === PunchType.BREAK_OUT) {
        if (!openBreakStart) {
          openBreakStart = punch.timestamp;
        } else {
          breakHours += (punch.timestamp.getTime() - openBreakStart.getTime()) / 3600000;
          openBreakStart = null;
        }
      } else if (punch.punchType === PunchType.OVERTIME_IN || punch.punchType === PunchType.OVERTIME_OUT) {
        if (!openOtStart) {
          openOtStart = punch.timestamp;
        } else {
          otPunchedHours += (punch.timestamp.getTime() - openOtStart.getTime()) / 3600000;
          openOtStart = null;
        }
      }
    }
    hoursWorked = Math.max(0, hoursWorked - breakHours);

    const shiftStart = parseShiftTime(sorted[0].timestamp, shift.shiftStart);
    const shiftEnd = new Date(shiftStart.getTime() + shift.standardDailyHours * 3600000);
    const graceMs = env.gracePeriodMinutes * 60000;
    const dayOfWeek = sorted[0].timestamp.getDay();
    const isWeekendOrHoliday = dayOfWeek === 0 || dayOfWeek === 6;

    days.push({
      date,
      firstIn: firstIn ? firstIn.toISOString() : null,
      lastOut: lastOut ? lastOut.toISOString() : null,
      hoursWorked: Math.round(hoursWorked * 100) / 100,
      breakHours: Math.round(breakHours * 100) / 100,
      otPunchedHours: Math.round(otPunchedHours * 100) / 100,
      lateArrival: firstIn ? firstIn.getTime() > shiftStart.getTime() + graceMs : false,
      earlyDeparture: lastOut ? lastOut.getTime() < shiftEnd.getTime() - graceMs : false,
      overtimeHours: Math.max(0, Math.round((hoursWorked - shift.standardDailyHours) * 100) / 100),
      holidayAttendanceEligible: isWeekendOrHoliday && hoursWorked >= env.holidayAttendanceThresholdHours,
      overtimeEligible: hoursWorked >= env.overtimeEligibleThresholdHours,
    });
  }

  return days;
}
