import { AuthUser, Role } from "@hr/shared";
import type { Holiday } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { recordAudit } from "../../lib/audit";
import { HttpError } from "../../lib/errors";
import { endOfUtcDay } from "../../lib/dateRange";
import type { createHolidaySchema } from "./validation";
import type { z } from "zod";

type AuditMeta = { ipAddress?: string; userAgent?: string };

/** Any authenticated user — needed so attendance/overtime eligibility
 * calculations (and the frontend's own display of holiday flags) can see
 * the calendar, not just HR. */
export async function listHolidays(from?: Date, to?: Date) {
  return prisma.holiday.findMany({
    where: from || to ? { date: { ...(from ? { gte: from } : {}), ...(to ? { lte: endOfUtcDay(to) } : {}) } } : {},
    orderBy: { date: "asc" },
  });
}

/** Maps "YYYY-MM-DD" -> HolidayType ("GOVERNMENT" | "PUBLIC") for every
 * declared Holiday row that applies to a given staff category (scoped ALL,
 * or scoped to that exact category — e.g. a school term-break day, which
 * only teaching staff get off). Pure function so callers who already have
 * the raw rows (the department dashboard, looping over many staff of
 * possibly different categories) don't need a separate query per staff
 * member. Does NOT include weekends — see resolveDayType for those.
 *
 * `category` is typed as a plain string (not @hr/shared's StaffCategory)
 * because callers pass Prisma query results — Prisma generates its own
 * nominally distinct enum type with identical string values, so comparing
 * by value here avoids a needless cast at every call site. */
export function holidayTypeMapForCategory(
  rows: Pick<Holiday, "date" | "scope" | "type">[],
  category: string
): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of rows) {
    if (r.scope === "ALL" || r.scope === category) {
      map.set(r.date.toISOString().slice(0, 10), r.type);
    }
  }
  return map;
}

/** Resolves a calendar date's holiday type for pay/attendance purposes, or
 * null if it's an ordinary working day. Every Saturday is GOVERNMENT and
 * every Friday is PUBLIC regardless of the Holiday table — the declared-
 * holiday map (already filtered to the staff member's category) only
 * matters for other weekdays. */
export function resolveDayType(date: Date, typeMap: Map<string, string>): "GOVERNMENT" | "PUBLIC" | null {
  const dayOfWeek = date.getDay();
  if (dayOfWeek === 5) return "PUBLIC"; // Friday
  if (dayOfWeek === 6) return "GOVERNMENT"; // Saturday
  const declared = typeMap.get(date.toISOString().slice(0, 10));
  return declared === "GOVERNMENT" || declared === "PUBLIC" ? declared : null;
}

/** Holiday type map for one staff member's category, for fast membership
 * checks in buildTimesheet. */
export async function holidayTypeMap(from: Date, to: Date, category: string): Promise<Map<string, string>> {
  const rows = await listHolidays(from, to);
  return holidayTypeMapForCategory(rows, category);
}

/** True if `date` should use the elevated Public-Holiday overtime rate for
 * this staff member — used to auto-derive OvertimeRequest.isHoliday from
 * the real calendar instead of trusting a manually-ticked checkbox. */
export async function isPublicHolidayDate(date: Date, category: string): Promise<boolean> {
  const map = await holidayTypeMap(date, date, category);
  return resolveDayType(date, map) === "PUBLIC";
}

export async function createHoliday(actor: AuthUser, input: z.infer<typeof createHolidaySchema>, meta: AuditMeta = {}) {
  if (actor.role !== Role.HR_ADMIN) throw new HttpError(403, "forbidden");

  const existing = await prisma.holiday.findUnique({ where: { date: input.date } });
  if (existing) throw new HttpError(409, "holiday_already_exists_for_date");

  const holiday = await prisma.holiday.create({ data: input });
  await recordAudit({
    actorId: actor.staffId,
    action: "HOLIDAY_CREATED",
    entity: "Holiday",
    entityId: holiday.id,
    after: input,
    ...meta,
  });
  return holiday;
}

export async function deleteHoliday(actor: AuthUser, id: string, meta: AuditMeta = {}) {
  if (actor.role !== Role.HR_ADMIN) throw new HttpError(403, "forbidden");

  const holiday = await prisma.holiday.findUnique({ where: { id } });
  if (!holiday) throw new HttpError(404, "not_found");

  await prisma.holiday.delete({ where: { id } });
  await recordAudit({
    actorId: actor.staffId,
    action: "HOLIDAY_DELETED",
    entity: "Holiday",
    entityId: id,
    before: { date: holiday.date, description: holiday.description },
    ...meta,
  });
  return { ok: true };
}
