import type { Staff } from "@prisma/client";
import { decryptField } from "../../lib/encryption";

/** Directory-list shape — safe for Staff/HOD/HR to see about anyone. */
export function toStaffSummary(staff: Staff) {
  return {
    id: staff.id,
    staffId: staff.staffId,
    fullName: staff.fullName,
    departmentId: staff.departmentId,
    designation: staff.designation,
    status: staff.status,
    photoDocumentId: staff.photoDocumentId,
  };
}

/**
 * Full profile detail — personal + employment info, national ID decrypted.
 * Never includes bank/payroll fields; those live on StaffBankDetail and are
 * served only by the HR/Admin-gated bank-details endpoint.
 */
export function toStaffDetail(staff: Staff) {
  return {
    id: staff.id,
    staffId: staff.staffId,
    fullName: staff.fullName,
    nationalId: decryptField(staff.nationalIdEnc),
    dob: staff.dob,
    gender: staff.gender,
    contactNumber: staff.contactNumber,
    personalEmail: staff.personalEmail,
    homeAddress: staff.homeAddress,
    emergencyContact: staff.emergencyContact,
    googleEmail: staff.googleEmail,
    role: staff.role,
    departmentId: staff.departmentId,
    designation: staff.designation,
    employmentType: staff.employmentType,
    dateJoined: staff.dateJoined,
    contractEndDate: staff.contractEndDate,
    reportingManagerId: staff.reportingManagerId,
    deviceUserId: staff.deviceUserId,
    status: staff.status,
    photoDocumentId: staff.photoDocumentId,
    createdAt: staff.createdAt,
    updatedAt: staff.updatedAt,
  };
}

/**
 * Audit-log snapshot — NEVER use toStaffDetail() for recordAudit() before/after
 * payloads. AuditLog is a broader-access, longer-retained dataset than Staff
 * itself, so it must never carry decrypted PII even though toStaffDetail()'s
 * decrypted `nationalId` is fine for an authorized API response.
 */
export function toStaffAuditSnapshot(staff: Staff) {
  return {
    id: staff.id,
    staffId: staff.staffId,
    fullName: staff.fullName,
    nationalId: "[REDACTED]",
    dob: staff.dob,
    gender: staff.gender,
    contactNumber: staff.contactNumber,
    personalEmail: staff.personalEmail,
    homeAddress: staff.homeAddress,
    emergencyContact: staff.emergencyContact,
    googleEmail: staff.googleEmail,
    role: staff.role,
    departmentId: staff.departmentId,
    designation: staff.designation,
    employmentType: staff.employmentType,
    dateJoined: staff.dateJoined,
    contractEndDate: staff.contractEndDate,
    status: staff.status,
  };
}

export function toBankDetail(bank: {
  bankName: string;
  accountNumberEnc: string;
  salaryGradeEnc: string;
}) {
  return {
    bankName: bank.bankName,
    accountNumber: decryptField(bank.accountNumberEnc),
    salaryGrade: decryptField(bank.salaryGradeEnc),
  };
}
