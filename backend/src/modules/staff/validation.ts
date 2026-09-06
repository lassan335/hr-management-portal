import { z } from "zod";
import { DocumentType, EmploymentType, Gender, Role, StaffStatus } from "@hr/shared";
import { STAFF_LOCKED_FIELDS, STAFF_SELF_EDITABLE_FIELDS } from "./fields";

export const createStaffSchema = z.object({
  staffId: z.string().min(1),
  fullName: z.string().min(1),
  nationalId: z.string().min(1),
  dob: z.coerce.date(),
  gender: z.nativeEnum(Gender),
  contactNumber: z.string().min(1),
  personalEmail: z.string().email(),
  homeAddress: z.string().min(1),
  emergencyContact: z.string().min(1),
  googleEmail: z.string().email(),
  departmentId: z.string().min(1),
  designation: z.string().min(1),
  employmentType: z.nativeEnum(EmploymentType),
  dateJoined: z.coerce.date(),
  contractEndDate: z.coerce.date().optional().nullable(),
  reportingManagerId: z.string().optional().nullable(),
  deviceUserId: z.string().optional().nullable(),
  role: z.nativeEnum(Role).optional(),
});

// HR/Admin direct update — every field is fair game, unlike the self-service
// edit-request flow below.
export const adminUpdateStaffSchema = createStaffSchema.partial();

export const selfEditableFieldEnum = z.enum(STAFF_SELF_EDITABLE_FIELDS);
export const lockedFieldEnum = z.enum(STAFF_LOCKED_FIELDS);

export const selfUpdateSchema = z.object({
  contactNumber: z.string().min(1).optional(),
  personalEmail: z.string().email().optional(),
  homeAddress: z.string().min(1).optional(),
  emergencyContact: z.string().min(1).optional(),
});

export const editRequestSchema = z.object({
  field: z.enum([...STAFF_SELF_EDITABLE_FIELDS, ...STAFF_LOCKED_FIELDS]),
  requestedValue: z.string().min(1),
});

/**
 * Per-field format validation for edit-request `requestedValue` (which is
 * always transported as a string). Without this, an invalid value only
 * surfaces as a raw 500 at approval time instead of a 400 at submission.
 * Fields with no entry here (e.g. free-text ones) are accepted as any
 * non-empty string, per editRequestSchema above.
 */
const FIELD_VALUE_VALIDATORS: Partial<Record<string, z.ZodTypeAny>> = {
  employmentType: z.nativeEnum(EmploymentType),
  dateJoined: z.coerce.date(),
  contractEndDate: z.coerce.date(),
  departmentId: z.string().min(1),
};

export function validateEditRequestValue(field: string, value: string): void {
  const schema = FIELD_VALUE_VALIDATORS[field];
  if (schema) schema.parse(value);
}

export const reviewEditRequestSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
});

export const statusChangeSchema = z.object({
  newStatus: z.nativeEnum(StaffStatus),
  reason: z.string().optional(),
});

export const qualificationSchema = z.object({
  type: z.string().min(1),
  institution: z.string().min(1),
  year: z.coerce.number().int().optional(),
  notes: z.string().optional(),
});

export const bankDetailsSchema = z.object({
  bankName: z.string().min(1),
  accountNumber: z.string().min(1),
  salaryGrade: z.string().min(1),
});

export const documentTypeSchema = z.nativeEnum(DocumentType);

export const staffListQuerySchema = z.object({
  departmentId: z.string().optional(),
  status: z.nativeEnum(StaffStatus).optional(),
  designation: z.string().optional(),
  q: z.string().optional(),
  format: z.enum(["json", "csv"]).optional(),
});
