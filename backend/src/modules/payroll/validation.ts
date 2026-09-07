import { z } from "zod";

export const periodQuerySchema = z.object({
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2000),
  format: z.enum(["json", "pdf", "excel"]).optional(),
});

export const bulkQuerySchema = z.object({
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2000),
  departmentId: z.string().optional(),
  format: z.enum(["pdf", "excel"]).optional().default("excel"),
});

export const adjustmentSchema = z.object({
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2000),
  mibDeduction: z.coerce.number().nonnegative().default(0),
  otherDeduction: z.coerce.number().nonnegative().default(0),
  absentDeduction: z.coerce.number().nonnegative().default(0),
  attendanceAllowancePerDay: z.coerce.number().nonnegative().default(0),
});
