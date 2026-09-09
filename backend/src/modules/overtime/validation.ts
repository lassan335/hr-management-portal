import { z } from "zod";

// timeIn/timeOut are "HH:mm" strings combined with `date` server-side —
// matches the legacy portal's separate Date / Time In / Time Out fields.
const timeString = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:mm");

// Shared by both a self-submitted request and a supervisor-assigned task —
// no isHoliday field: whether Government/Public Holiday rates apply is
// derived server-side from the real academic calendar (see
// overtime/service.ts's submitRequest/assignTask), not a client checkbox.
const otSlotFields = {
  date: z.coerce.date(),
  timeIn: timeString,
  timeOut: timeString,
  reason: z.string().min(1),
  notes: z.string().optional(),
};

export const overtimeRequestSchema = z.object({
  ...otSlotFields,
  // The staff member picks who reviews this request — see
  // overtime/service.ts's submitRequest for eligibility (Staff.canSupervise
  // or HR_ADMIN). Required: a self-submitted request must always name a
  // reviewer, matching the "send OT request for selected supervisor" flow.
  supervisorId: z.string().min(1),
});

// After approval, the staff member reports the actual time they worked
// (see overtime/service.ts's reportOvertimeCompletion) — replaces waiting
// on a device-punch match as the normal completion path.
export const reportCompletionSchema = z.object({
  timeIn: timeString,
  timeOut: timeString,
});

// A supervisor assigning a task directly to someone else — no supervisorId
// here: the actor doing the assigning already IS the reviewer, so the task
// is pre-approved and never goes through the review step at all.
export const assignOvertimeSchema = z.object({
  ...otSlotFields,
  staffId: z.string().min(1),
});

export const reviewSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
});

// `manual: true` is HR's explicit override when no device punch is found —
// see overtime/service.ts's completeWork() doc comment.
export const completeWorkSchema = z.object({
  manual: z.boolean().optional().default(false),
  note: z.string().optional(),
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

export const reportQuerySchema = dashboardQuerySchema.extend({
  format: z.enum(["pdf", "excel"]).optional().default("excel"),
});
