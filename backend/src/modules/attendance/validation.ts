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

// One row per staff for a single calendar day — see getDailyAttendance().
export const dailyAttendanceQuerySchema = z.object({
  departmentId: z.string().optional(),
  date: z.coerce.date(),
});

// Attendance Eligible List follows the same 16th-15th OT pay period as the
// overtime reports (month/year), not an arbitrary from/to range.
export const eligibleListQuerySchema = z.object({
  departmentId: z.string().optional(),
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2000),
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
