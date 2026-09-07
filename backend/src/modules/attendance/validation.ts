import { z } from "zod";
import { PunchType } from "@hr/shared";

export const clockSchema = z.object({
  punchType: z.nativeEnum(PunchType),
});

export const timesheetQuerySchema = z.object({
  staffId: z.string().optional(),
  from: z.coerce.date(),
  to: z.coerce.date(),
  format: z.enum(["json", "csv", "pdf"]).optional(),
});

export const dashboardQuerySchema = z.object({
  departmentId: z.string().optional(),
  from: z.coerce.date(),
  to: z.coerce.date(),
});

export const reportQuerySchema = dashboardQuerySchema.extend({
  format: z.enum(["pdf", "excel"]).optional().default("excel"),
});

export const resolveUnmatchedSchema = z.object({
  staffId: z.string().min(1),
});

export const correctionSchema = z.object({
  date: z.coerce.date(),
  requestedPunchType: z.nativeEnum(PunchType),
  requestedTime: z.coerce.date(),
  reason: z.string().min(1),
  timeEntryId: z.string().optional().nullable(),
});

export const reviewSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
});
