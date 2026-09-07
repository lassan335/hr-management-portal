/**
 * A date-only query param like "2026-09-01" parses (via `z.coerce.date()`)
 * to midnight UTC on that day. Used directly as an inclusive upper bound
 * (`lte: to`), that excludes every entry later that same calendar day —
 * exactly the entries a "to: 2026-09-01" filter is supposed to include.
 * Push it to the last instant of that UTC day before using it as `lte`.
 */
export function endOfUtcDay(date: Date): Date {
  const end = new Date(date);
  end.setUTCHours(23, 59, 59, 999);
  return end;
}

/**
 * The pay period labeled "month" runs from env.otPeriodStartDay of the
 * PREVIOUS month through (otPeriodStartDay - 1) of "month" — e.g. with the
 * default start day 16, the "September" period is 16 Aug -> 15 Sep, matching
 * the legacy portal's payroll/OT period. Shared by the overtime module and
 * salary slip generation so both agree on what "the September period" means.
 */
export function payPeriodRange(month: number, year: number, startDay: number): { from: Date; to: Date } {
  const from = new Date(year, month - 2, startDay);
  const to = new Date(year, month - 1, startDay - 1, 23, 59, 59, 999);
  return { from, to };
}
