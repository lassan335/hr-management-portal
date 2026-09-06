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
