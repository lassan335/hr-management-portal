/** Formats a decimal hours value as "Xh Ym" (e.g. 4.5 -> "4h 30m"), matching
 * the legacy OT/attendance reports' Hrs:Min columns — HR reads printed
 * payroll sheets in hours-and-minutes, not decimal hours. */
export function formatHm(hours: number): string {
  const totalMinutes = Math.round(Math.max(0, hours) * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

/** Same as formatHm, but a zero value prints as "-" — matches the legacy
 * Attendance Eligible List's convention for a day with no recorded work. */
export function formatHmOrDash(hours: number): string {
  return hours > 0 ? formatHm(hours) : "-";
}
