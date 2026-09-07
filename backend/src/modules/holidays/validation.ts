import { z } from "zod";

export const createHolidaySchema = z.object({
  date: z.coerce.date(),
  description: z.string().min(1),
});

export const listHolidaysQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
