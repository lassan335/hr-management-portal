import { z } from "zod";
import { HolidayScope, HolidayType } from "@hr/shared";

export const createHolidaySchema = z.object({
  date: z.coerce.date(),
  description: z.string().min(1),
  scope: z.nativeEnum(HolidayScope).optional().default(HolidayScope.ALL),
  type: z.nativeEnum(HolidayType).optional().default(HolidayType.PUBLIC),
});

export const listHolidaysQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
