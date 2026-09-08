// Shared enums and DTO types used by both backend and frontend.
// Keep this package free of runtime dependencies — types/enums only.

export enum Role {
  STAFF = "STAFF",
  HOD = "HOD",
  HR_ADMIN = "HR_ADMIN",
}

export enum Gender {
  MALE = "MALE",
  FEMALE = "FEMALE",
  OTHER = "OTHER",
}

export enum EmploymentType {
  PERMANENT = "PERMANENT",
  CONTRACT = "CONTRACT",
  PART_TIME = "PART_TIME",
}

export enum StaffStatus {
  ACTIVE = "ACTIVE",
  ON_LEAVE = "ON_LEAVE",
  SUSPENDED = "SUSPENDED",
  RESIGNED = "RESIGNED",
  TERMINATED = "TERMINATED",
}

// Which academic-calendar holiday group a staff member follows — distinct
// from Role (access level) and StaffGroup (shift hours).
export enum StaffCategory {
  TEACHING = "TEACHING",
  NON_TEACHING = "NON_TEACHING",
}

// Which staff category a Holiday applies to. ALL = everyone off (a real
// public holiday); TEACHING = a school term-break day (teachers only).
export enum HolidayScope {
  ALL = "ALL",
  TEACHING = "TEACHING",
  NON_TEACHING = "NON_TEACHING",
}

// Pay/attendance treatment for a holiday, orthogonal to HolidayScope (who
// it applies to). GOVERNMENT: same OT rate as a normal day, OT-eligible
// only past the standard daily-hours threshold. PUBLIC: elevated OT rate,
// OT-eligible from the first minute worked. Every Saturday is GOVERNMENT
// and every Friday is PUBLIC regardless of the Holiday table.
export enum HolidayType {
  GOVERNMENT = "GOVERNMENT",
  PUBLIC = "PUBLIC",
}

// Shared staff -> HOD -> HR/Admin approval chain, used by overtime, leave,
// and staff edit requests.
export enum ApprovalStatus {
  PENDING_HOD = "PENDING_HOD",
  PENDING_HR = "PENDING_HR",
  APPROVED = "APPROVED",
  REJECTED = "REJECTED",
}

export enum PunchType {
  CHECK_IN = "CHECK_IN",
  CHECK_OUT = "CHECK_OUT",
  BREAK_IN = "BREAK_IN",
  BREAK_OUT = "BREAK_OUT",
  OVERTIME_IN = "OVERTIME_IN",
  OVERTIME_OUT = "OVERTIME_OUT",
}

export enum AttendanceSource {
  MANUAL = "MANUAL",
  IMPORT = "IMPORT",
  DEVICE = "DEVICE",
}

export enum DocumentType {
  ID = "ID",
  CONTRACT = "CONTRACT",
  CERTIFICATE = "CERTIFICATE",
  PHOTO = "PHOTO",
  OTHER = "OTHER",
}

export enum NotificationType {
  OVERTIME_SUBMITTED = "OVERTIME_SUBMITTED",
  OVERTIME_APPROVED = "OVERTIME_APPROVED",
  OVERTIME_REJECTED = "OVERTIME_REJECTED",
  OVERTIME_WORK_COMPLETED = "OVERTIME_WORK_COMPLETED",
  OVERTIME_TASK_ASSIGNED = "OVERTIME_TASK_ASSIGNED",
  LEAVE_SUBMITTED = "LEAVE_SUBMITTED",
  LEAVE_APPROVED = "LEAVE_APPROVED",
  LEAVE_REJECTED = "LEAVE_REJECTED",
  EDIT_REQUEST_SUBMITTED = "EDIT_REQUEST_SUBMITTED",
  EDIT_REQUEST_APPROVED = "EDIT_REQUEST_APPROVED",
  EDIT_REQUEST_REJECTED = "EDIT_REQUEST_REJECTED",
  ATTENDANCE_CORRECTION_SUBMITTED = "ATTENDANCE_CORRECTION_SUBMITTED",
  ATTENDANCE_CORRECTION_REVIEWED = "ATTENDANCE_CORRECTION_REVIEWED",
  ATTENDANCE_IMPORT_FAILED = "ATTENDANCE_IMPORT_FAILED",
  ATTENDANCE_DEVICE_RESOLVED = "ATTENDANCE_DEVICE_RESOLVED",
}

/** The authenticated user shape attached to req.user after auth middleware runs. */
export interface AuthUser {
  staffId: string;
  role: Role;
  departmentId: string | null;
  fullName: string;
  googleEmail: string;
  /** Must match Staff.sessionVersion at request time — a mismatch means the
   * session was revoked (logout, status/role change) and is rejected. */
  sessionVersion: number;
}

/** Directory-list shape — safe for any authenticated role to see. */
export interface StaffSummary {
  id: string;
  staffId: string;
  fullName: string;
  departmentId: string;
  designation: string;
  status: StaffStatus;
  photoFileId: string | null;
}

/** Bank/payroll fields — only ever populated when the requester is HR_ADMIN. */
export interface StaffPayrollDetail {
  bankName: string;
  accountNumber: string;
  salaryGrade: string;
}
