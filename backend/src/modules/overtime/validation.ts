import { z } from "zod";

// timeIn/timeOut are "HH:mm" strings combined with `date` server-side —
// matches the legacy portal's separate Date / Time In / Time Out fields.
const timeString = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:mm");

export const overtimeRequestSchema = z.object({
  date: z.coerce.date(),
  timeIn: timeString,
  timeOut: timeString,
  reason: z.string().min(1),
  notes: z.string().optional(),
  isHoliday: z.boolean().optional().default(false),
});

export const reviewSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
});

export const rateSchema = z.object({
  departmentId: z.string().min(1),
  weekdayRate: z.coerce.number().nonnegative(),
  weekendRate: z.coerce.number().nonnegative(),
  holidayRate: z.coerce.number().nonnegative(),
});

export const summaryQuerySchema = z.object({
  staffId: z.string().optional(),
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2000),
  format: z.enum(["json", "csv", "pdf"]).optional(),
});

export const dashboardQuerySchema = z.object({
  departmentId: z.string().optional(),
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2000),
});
