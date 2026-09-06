// Which Staff fields a staff member can edit directly vs. only request (HR
// approves before it's applied). Bank/payroll fields aren't listed at all —
// they live on StaffBankDetail and are never staff-editable or staff-visible.

export const STAFF_SELF_EDITABLE_FIELDS = [
  "contactNumber",
  "personalEmail",
  "homeAddress",
  "emergencyContact",
] as const;

export const STAFF_LOCKED_FIELDS = [
  "nationalId",
  "employmentType",
  "departmentId",
  "designation",
  "dateJoined",
  "contractEndDate",
] as const;

// Locked fields whose value is encrypted at rest on the Staff row, and so must
// also be stored encrypted while a change request is pending review.
export const ENCRYPTED_STAFF_FIELDS = new Set(["nationalId"]);

export type StaffSelfEditableField = (typeof STAFF_SELF_EDITABLE_FIELDS)[number];
export type StaffLockedField = (typeof STAFF_LOCKED_FIELDS)[number];

export function isSelfEditableField(field: string): field is StaffSelfEditableField {
  return (STAFF_SELF_EDITABLE_FIELDS as readonly string[]).includes(field);
}

export function isLockedField(field: string): field is StaffLockedField {
  return (STAFF_LOCKED_FIELDS as readonly string[]).includes(field);
}
