import { AuthUser, Role } from "@hr/shared";
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

/** Set of "YYYY-MM-DD" strings for fast membership checks in buildTimesheet. */
export async function holidayDateSet(from: Date, to: Date): Promise<Set<string>> {
  const rows = await listHolidays(from, to);
  return new Set(rows.map((r) => r.date.toISOString().slice(0, 10)));
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
