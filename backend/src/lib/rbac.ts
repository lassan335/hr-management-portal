import { Request, Response, NextFunction } from "express";
import { Role } from "@hr/shared";

/** Must run after `authenticate` — 401s (not 403s) belong to auth, not here. */
export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: "unauthenticated" });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: "forbidden" });
    }
    next();
  };
}

/**
 * True if the requester may act on a record belonging to `targetStaffId` in
 * `targetDepartmentId`: Staff can only act on their own record; HOD can act on
 * any record in their own department; HR_ADMIN can act on anything.
 * Use this inside controllers for row-level checks — requireRole() alone only
 * gates by role, not by whose record is being touched.
 */
export function canAccessStaffRecord(
  requester: { staffId: string; role: Role; departmentId: string | null },
  targetStaffId: string,
  targetDepartmentId: string
): boolean {
  if (requester.role === Role.HR_ADMIN) return true;
  if (requester.role === Role.HOD) return requester.departmentId === targetDepartmentId;
  return requester.staffId === targetStaffId;
}

/** True only for HR/Admin — gates payroll/bank/national-ID fields specifically. */
export function isHrAdmin(role: Role): boolean {
  return role === Role.HR_ADMIN;
}
