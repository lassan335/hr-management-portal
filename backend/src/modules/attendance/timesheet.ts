import { PunchType } from "@hr/shared";
import { env } from "../../lib/env";
import { resolveDayType } from "../holidays/service";

export interface DayTimesheet {
  date: string;
  firstIn: string | null;
  lastOut: string | null;
  /** Every raw punch that day, chronological — the individual Check
   * In/Out, Break In/Out, and Overtime In/Out taps behind the summary
   * columns above. */
  punches: { timestamp: string; punchType: string }[];
  /** Payroll hours: simply lastOut minus firstIn. Break/overtime punches
   * are informational only (see breakHours/otPunchedHours below) and never
   * change this — per school policy, only Check In/Check Out count toward
   * paid hours. */
  hoursWorked: number;
  /** Total time between paired BREAK_IN/BREAK_OUT punches — shown for
   * reference only, NOT subtracted from hoursWorked above. */
  breakHours: number;
  /** Total time between paired OVERTIME_IN/OVERTIME_OUT punches — the
   * staff member's ACTUAL clocked overtime, separate from `overtimeHours`
   * below (which is just worked-time-over-standard-hours). Cross-checking
   * the two against an approved OvertimeRequest slot is a further step not
   * implemented here (see README's "Deferred / out of scope"). */
  otPunchedHours: number;
  lateArrival: boolean;
  /** Minutes between shiftStart and firstIn — 0 when not late. Used by the
   * salary slip's per-minute late deduction. */
  lateMinutes: number;
  /** True when there's a CHECK_OUT that day but no CHECK_IN at all — the
   * mirror case of missingCheckout below. hoursWorked is 0 for the day when
   * this is true, since there's no check-in to measure from. */
  earlyDeparture: boolean;
  /** True when there's a CHECK_IN that day but no CHECK_OUT at all — a
   * missed final tap. hoursWorked is 0 for the day when this is true, since
   * there's no checkout to measure to. */
  missingCheckout: boolean;
  overtimeHours: number;
  /** True if this date is the Fri/Sat weekend or an explicit Holiday row
   * (see the `holidays` module — Public Holidays / Non-Working Days). */
  isHoliday: boolean;
  /** GOVERNMENT (Saturday, or a declared holiday explicitly typed that way)
   * or PUBLIC (Friday, or a declared holiday — the default) — null on an
   * ordinary working day. Public gets the elevated OT rate and is
   * OT-eligible from the first minute worked; Government uses the same
   * rate/threshold as a normal day. See holidays/service.ts's
   * resolveDayType. */
  holidayType: "GOVERNMENT" | "PUBLIC" | null;
  /** On a weekend/holiday, attendance counts once >= 3h is worked that day. */
  holidayAttendanceEligible: boolean;
  /** Uniform 8h/day threshold before any worked time counts as
   * overtime-eligible — distinct from `overtimeHours` above, which is the
   * surplus over this staff member's own group's standard daily hours (may
   * be 6h for some groups). A staff member on a 6h-standard group could
   * show overtimeHours > 0 while still not being "eligible" until 8h. On a
   * PUBLIC holiday this threshold doesn't apply at all — any work counts. */
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

/** Payroll hours for a calendar day are simply its latest CHECK_OUT minus
 * its earliest CHECK_IN (school policy: only Check In/Check Out count
 * toward paid time). BREAK_IN/BREAK_OUT and OVERTIME_IN/OVERTIME_OUT are
 * tracked separately purely for display (breakHours/otPunchedHours) and
 * never affect hoursWorked — the attendance device can't reliably tell a
 * real break from someone stepping out and back in, so treating a break
 * punch as payroll-affecting would risk silently under-paying someone.
 * Late arrival is flagged against the given shift window (see
 * shiftSettingsFor — resolved per staff member from their StaffGroup).
 * "Early leave"/"missing checkout" aren't about the shift window at all —
 * they flag a day with only one half of the Check In/Check Out pair: a
 * CHECK_IN with no CHECK_OUT (missingCheckout) or a CHECK_OUT with no
 * CHECK_IN (earlyDeparture).
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
  shift: ShiftSettings,
  /** "YYYY-MM-DD" -> HolidayType for declared Holiday rows that apply to
   * this staff member's category (see holidays/service.ts's
   * holidayTypeMapForCategory). The recurring Fri/Sat weekend is resolved
   * separately by resolveDayType and always applies regardless of this map. */
  holidayTypes: Map<string, string> = new Map()
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

    let breakHours = 0;
    let otPunchedHours = 0;
    let openBreakStart: Date | null = null;
    let openOtStart: Date | null = null;
    let firstIn: Date | null = null;
    let lastOut: Date | null = null;

    for (const punch of sorted) {
      if (punch.punchType === PunchType.CHECK_IN) {
        if (!firstIn) firstIn = punch.timestamp;
      } else if (punch.punchType === PunchType.CHECK_OUT) {
        lastOut = punch.timestamp;
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

    // No CHECK_OUT at all that day — a missed final tap. hoursWorked stays
    // 0 rather than guessing; missingCheckout tells the UI/reports why.
    const missingCheckout = firstIn !== null && lastOut === null;
    // Mirror case: a CHECK_OUT with no CHECK_IN that day.
    const earlyDeparture = lastOut !== null && firstIn === null;
    const hoursWorked =
      firstIn && lastOut ? Math.max(0, (lastOut.getTime() - firstIn.getTime()) / 3600000) : 0;

    const shiftStart = parseShiftTime(sorted[0].timestamp, shift.shiftStart);
    const graceMs = env.gracePeriodMinutes * 60000;
    // Maldives weekend is Friday(5)/Saturday(6), not Saturday/Sunday —
    // Friday resolves PUBLIC, Saturday GOVERNMENT, regardless of the
    // declared-holiday map (see resolveDayType).
    const holidayType = resolveDayType(sorted[0].timestamp, holidayTypes);
    const isHoliday = holidayType !== null;
    const lateArrival = firstIn ? firstIn.getTime() > shiftStart.getTime() + graceMs : false;

    days.push({
      date,
      firstIn: firstIn ? firstIn.toISOString() : null,
      lastOut: lastOut ? lastOut.toISOString() : null,
      punches: sorted.map((p) => ({ timestamp: p.timestamp.toISOString(), punchType: p.punchType })),
      hoursWorked: Math.round(hoursWorked * 100) / 100,
      breakHours: Math.round(breakHours * 100) / 100,
      otPunchedHours: Math.round(otPunchedHours * 100) / 100,
      lateArrival,
      lateMinutes: lateArrival && firstIn ? Math.round((firstIn.getTime() - shiftStart.getTime()) / 60000) : 0,
      missingCheckout,
      earlyDeparture,
      overtimeHours: Math.max(0, Math.round((hoursWorked - shift.standardDailyHours) * 100) / 100),
      isHoliday,
      holidayType,
      holidayAttendanceEligible: isHoliday && hoursWorked >= env.holidayAttendanceThresholdHours,
      // Public Holiday: any work at all counts (even 1 minute) — no
      // threshold. Government Holiday and ordinary working days: the usual
      // uniform threshold applies.
      overtimeEligible: holidayType === "PUBLIC" ? hoursWorked > 0 : hoursWorked >= env.overtimeEligibleThresholdHours,
    });
  }

  return days;
}
