import { z } from "zod";

export const leaveTypeSchema = z.object({
  name: z.string().min(1),
  accrualRule: z.string().optional(),
  isCustom: z.boolean().optional().default(true),
  deductsBalance: z.boolean().optional().default(true),
});

export const termCalendarSchema = z.object({
  termName: z.string().min(1),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  blocksLeave: z.boolean().optional().default(false),
});

export const leaveRequestSchema = z.object({
  leaveTypeId: z.string().min(1),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  reason: z.string().optional(),
});

export const reviewSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
});

export const balanceSchema = z.object({
  staffId: z.string().min(1),
  leaveTypeId: z.string().min(1),
  year: z.coerce.number().int().min(2000),
  balanceDays: z.coerce.number().nonnegative(),
});

export const calendarQuerySchema = z.object({
  departmentId: z.string().optional(),
  from: z.coerce.date(),
  to: z.coerce.date(),
});
