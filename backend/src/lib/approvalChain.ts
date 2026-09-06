import { AuthUser, Role } from "@hr/shared";
import { HttpError } from "./errors";

export type ApprovalStatusValue = "PENDING_HOD" | "PENDING_HR" | "APPROVED" | "REJECTED";

/**
 * Shared staff -> HOD -> HR/Admin approval chain used by attendance
 * corrections, overtime requests, and leave requests. A HOD can only act on
 * PENDING_HOD requests from their own department; HR/Admin can act at either
 * stage (covers the case where a request needs HR's final sign-off, and lets
 * HR override/fast-track when a department has no active HOD).
 */
export function nextApprovalStatus(params: {
  current: ApprovalStatusValue;
  reviewer: AuthUser;
  requestDepartmentId: string;
  decision: "APPROVE" | "REJECT";
}): ApprovalStatusValue {
  const { current, reviewer, requestDepartmentId, decision } = params;

  if (current === "APPROVED" || current === "REJECTED") {
    throw new HttpError(409, "already_reviewed");
  }

  if (decision === "REJECT") {
    const canReject =
      reviewer.role === Role.HR_ADMIN ||
      (reviewer.role === Role.HOD && reviewer.departmentId === requestDepartmentId && current === "PENDING_HOD");
    if (!canReject) throw new HttpError(403, "forbidden");
    return "REJECTED";
  }

  if (current === "PENDING_HOD") {
    const canApprove = reviewer.role === Role.HR_ADMIN || (reviewer.role === Role.HOD && reviewer.departmentId === requestDepartmentId);
    if (!canApprove) throw new HttpError(403, "forbidden");
    // HR approving directly at the HOD stage fast-tracks straight to APPROVED.
    return reviewer.role === Role.HR_ADMIN ? "APPROVED" : "PENDING_HR";
  }

  if (current === "PENDING_HR") {
    if (reviewer.role !== Role.HR_ADMIN) throw new HttpError(403, "forbidden");
    return "APPROVED";
  }

  throw new HttpError(400, "invalid_status");
}
