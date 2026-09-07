import { AuthUser, NotificationType, Role, StaffStatus } from "@hr/shared";
import { prisma } from "../../lib/prisma";
import { encryptField, decryptField } from "../../lib/encryption";
import { recordAudit } from "../../lib/audit";
import { bumpSessionVersion } from "../../lib/auth";
import { notify } from "../../lib/notifications";
import { toStaffSummary, toStaffDetail, toStaffAuditSnapshot, toBankDetail } from "./serializers";
import { ENCRYPTED_STAFF_FIELDS, isLockedField, isSelfEditableField } from "./fields";
import { validateEditRequestValue } from "./validation";
import type {
  createStaffSchema,
  adminUpdateStaffSchema,
  editRequestSchema,
  statusChangeSchema,
  qualificationSchema,
  bankDetailsSchema,
  staffListQuerySchema,
} from "./validation";
import type { z } from "zod";

type ListQuery = z.infer<typeof staffListQuerySchema>;
type AuditMeta = { ipAddress?: string; userAgent?: string };

/** national ID / bank account numbers should never appear in full even in an
 * audit trail meant for humans to skim — last 4 digits is enough to trace. */
function maskSensitive(value: string): string {
  if (value.length <= 4) return "****";
  return `****${value.slice(-4)}`;
}

/** Any authenticated user — just id/name, needed for role-assignment and
 * staff-creation dropdowns. Not sensitive. */
export async function listDepartments() {
  return prisma.department.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } });
}

/** HR/Admin: full directory. HOD: department-scoped. Staff: forbidden (use /me). */
export async function listStaff(requester: AuthUser, query: ListQuery) {
  const where: Record<string, unknown> = {};

  if (requester.role === Role.HOD) {
    where.departmentId = requester.departmentId ?? "__none__";
  } else if (requester.role === Role.HR_ADMIN) {
    if (query.departmentId) where.departmentId = query.departmentId;
  } else {
    throw Object.assign(new Error("forbidden"), { status: 403 });
  }

  if (query.status) where.status = query.status;
  if (query.designation) where.designation = { contains: query.designation, mode: "insensitive" };
  if (query.q) {
    where.OR = [
      { fullName: { contains: query.q, mode: "insensitive" } },
      { staffId: { contains: query.q, mode: "insensitive" } },
    ];
  }

  const staff = await prisma.staff.findMany({ where, orderBy: { fullName: "asc" } });
  return staff.map(toStaffSummary);
}

export async function getStaffDetail(requester: AuthUser, targetId: string) {
  const staff = await prisma.staff.findUnique({ where: { id: targetId } });
  if (!staff) throw Object.assign(new Error("not_found"), { status: 404 });

  const isSelf = requester.staffId === staff.id;
  const isHr = requester.role === Role.HR_ADMIN;
  const isHodOfDept = requester.role === Role.HOD && requester.departmentId === staff.departmentId;

  if (isSelf || isHr) return toStaffDetail(staff);
  if (isHodOfDept) return toStaffSummary(staff);
  throw Object.assign(new Error("forbidden"), { status: 403 });
}

export async function createStaff(
  actor: AuthUser,
  input: z.infer<typeof createStaffSchema>,
  meta: AuditMeta = {}
) {
  const staff = await prisma.staff.create({
    data: {
      staffId: input.staffId,
      fullName: input.fullName,
      nationalIdEnc: encryptField(input.nationalId),
      dob: input.dob,
      gender: input.gender,
      contactNumber: input.contactNumber,
      personalEmail: input.personalEmail,
      homeAddress: input.homeAddress,
      emergencyContact: input.emergencyContact,
      googleEmail: input.googleEmail,
      departmentId: input.departmentId,
      designation: input.designation,
      employmentType: input.employmentType,
      dateJoined: input.dateJoined,
      contractEndDate: input.contractEndDate ?? null,
      reportingManagerId: input.reportingManagerId ?? null,
      deviceUserId: input.deviceUserId ?? null,
      role: input.role,
    },
  });

  await prisma.staffStatusHistory.create({
    data: { staffId: staff.id, oldStatus: null, newStatus: StaffStatus.ACTIVE, changedBy: actor.staffId },
  });
  await recordAudit({
    actorId: actor.staffId,
    action: "CREATE",
    entity: "Staff",
    entityId: staff.id,
    after: toStaffAuditSnapshot(staff),
    ...meta,
  });

  return toStaffDetail(staff);
}

/** HR/Admin only — direct write, bypasses the edit-request approval flow. */
export async function adminUpdateStaff(
  actor: AuthUser,
  targetId: string,
  input: z.infer<typeof adminUpdateStaffSchema>,
  meta: AuditMeta = {}
) {
  const before = await prisma.staff.findUnique({ where: { id: targetId } });
  if (!before) throw Object.assign(new Error("not_found"), { status: 404 });

  const { nationalId, ...rest } = input;
  const data: Record<string, unknown> = { ...rest };
  if (nationalId) data.nationalIdEnc = encryptField(nationalId);

  const updated = await prisma.staff.update({ where: { id: targetId }, data });

  // Role/department changes affect what a live session is authorized to do —
  // revoke any outstanding session so it's re-issued with the new claims.
  if (
    (input.role !== undefined && input.role !== before.role) ||
    (input.departmentId !== undefined && input.departmentId !== before.departmentId)
  ) {
    await bumpSessionVersion(targetId);
  }

  await recordAudit({
    actorId: actor.staffId,
    action: "UPDATE",
    entity: "Staff",
    entityId: targetId,
    before: toStaffAuditSnapshot(before),
    after: toStaffAuditSnapshot(updated),
    ...meta,
  });
  return toStaffDetail(updated);
}

export async function changeStatus(
  actor: AuthUser,
  targetId: string,
  input: z.infer<typeof statusChangeSchema>,
  meta: AuditMeta = {}
) {
  const staff = await prisma.staff.findUnique({ where: { id: targetId } });
  if (!staff) throw Object.assign(new Error("not_found"), { status: 404 });

  const updated = await prisma.staff.update({
    where: { id: targetId },
    data: { status: input.newStatus },
  });

  // A status change (esp. SUSPENDED/TERMINATED) must take effect immediately,
  // not after the terminated user's existing session JWT happens to expire.
  await bumpSessionVersion(targetId);

  await prisma.staffStatusHistory.create({
    data: {
      staffId: targetId,
      oldStatus: staff.status,
      newStatus: input.newStatus,
      changedBy: actor.staffId,
      reason: input.reason,
    },
  });
  await recordAudit({
    actorId: actor.staffId,
    action: "STATUS_CHANGE",
    entity: "Staff",
    entityId: targetId,
    before: { status: staff.status },
    after: { status: input.newStatus, reason: input.reason },
    ...meta,
  });
  return toStaffDetail(updated);
}

export async function getStatusHistory(requester: AuthUser, targetId: string) {
  const staff = await prisma.staff.findUnique({ where: { id: targetId } });
  if (!staff) throw Object.assign(new Error("not_found"), { status: 404 });
  const isSelf = requester.staffId === targetId;
  if (!isSelf && requester.role !== Role.HR_ADMIN) {
    throw Object.assign(new Error("forbidden"), { status: 403 });
  }
  return prisma.staffStatusHistory.findMany({
    where: { staffId: targetId },
    orderBy: { changedAt: "desc" },
  });
}

/**
 * Self-editable fields apply immediately (no bank/salary/national-ID access
 * here at all, so nothing sensitive is at stake in a direct self-PATCH).
 * Locked fields must go through submitEditRequest() instead.
 */
export async function selfUpdateStaff(actor: AuthUser, patch: Record<string, string>, meta: AuditMeta = {}) {
  const before = await prisma.staff.findUnique({ where: { id: actor.staffId } });
  if (!before) throw Object.assign(new Error("not_found"), { status: 404 });

  const updated = await prisma.staff.update({ where: { id: actor.staffId }, data: patch });
  await recordAudit({
    actorId: actor.staffId,
    action: "SELF_UPDATE",
    entity: "Staff",
    entityId: actor.staffId,
    before: toStaffAuditSnapshot(before),
    after: patch,
    ...meta,
  });
  return toStaffDetail(updated);
}

export async function submitEditRequest(
  actor: AuthUser,
  targetId: string,
  input: z.infer<typeof editRequestSchema>,
  meta: AuditMeta = {}
) {
  if (actor.staffId !== targetId && actor.role !== Role.HR_ADMIN) {
    throw Object.assign(new Error("forbidden"), { status: 403 });
  }
  if (!isSelfEditableField(input.field) && !isLockedField(input.field)) {
    throw Object.assign(new Error("unknown_field"), { status: 400 });
  }
  // Fails fast with a 400 here instead of a 500 for HR at approval time.
  validateEditRequestValue(input.field, input.requestedValue);

  const staff = await prisma.staff.findUnique({ where: { id: targetId } });
  if (!staff) throw Object.assign(new Error("not_found"), { status: 404 });

  const isEncryptedField = ENCRYPTED_STAFF_FIELDS.has(input.field);
  const rawCurrent = isEncryptedField
    ? decryptField((staff as unknown as Record<string, string>)[`${input.field}Enc`])
    : String((staff as unknown as Record<string, unknown>)[input.field] ?? "");
  const currentValue = isEncryptedField ? maskSensitive(rawCurrent) : rawCurrent;
  const storedRequestedValue = isEncryptedField ? encryptField(input.requestedValue) : input.requestedValue;

  const request = await prisma.staffEditRequest.create({
    data: {
      staffId: targetId,
      field: input.field,
      currentValue,
      requestedValue: storedRequestedValue,
    },
  });

  await recordAudit({
    actorId: actor.staffId,
    action: "EDIT_REQUEST_SUBMITTED",
    entity: "StaffEditRequest",
    entityId: request.id,
    after: { field: input.field },
    ...meta,
  });
  await notify({
    staffId: targetId,
    type: NotificationType.EDIT_REQUEST_SUBMITTED,
    message: `Edit request submitted for field "${input.field}".`,
  });

  return request;
}

/** HR-facing list — decrypts requestedValue for encrypted fields (e.g.
 * nationalId) so a reviewer can actually see what they're approving, rather
 * than raw AES-GCM ciphertext. */
export async function listEditRequests(requester: AuthUser) {
  if (requester.role === Role.HR_ADMIN) {
    const requests = await prisma.staffEditRequest.findMany({
      where: { status: "PENDING_HR" },
      orderBy: { createdAt: "asc" },
      include: { staff: { select: { fullName: true, staffId: true } } },
    });
    return requests.map((r) =>
      ENCRYPTED_STAFF_FIELDS.has(r.field) ? { ...r, requestedValue: decryptField(r.requestedValue) } : r
    );
  }
  return prisma.staffEditRequest.findMany({
    where: { staffId: requester.staffId },
    orderBy: { createdAt: "desc" },
  });
}

export async function reviewEditRequest(
  actor: AuthUser,
  requestId: string,
  decision: "APPROVED" | "REJECTED",
  meta: AuditMeta = {}
) {
  // Atomic compare-and-set: only one concurrent reviewer can win this update:
  // a second racing request/click sees count === 0 and gets a clean 409
  // instead of both writes applying (and a possible double state change).
  const { count } = await prisma.staffEditRequest.updateMany({
    where: { id: requestId, status: "PENDING_HR" },
    data: { status: decision, reviewedBy: actor.staffId, reviewedAt: new Date() },
  });
  if (count === 0) throw Object.assign(new Error("already_reviewed"), { status: 409 });

  const updatedRequest = await prisma.staffEditRequest.findUniqueOrThrow({ where: { id: requestId } });

  if (decision === "APPROVED") {
    const field = updatedRequest.field;
    const value = updatedRequest.requestedValue;
    const data: Record<string, unknown> = ENCRYPTED_STAFF_FIELDS.has(field)
      ? { nationalIdEnc: value }
      : { [field]: value };
    await prisma.staff.update({ where: { id: updatedRequest.staffId }, data });
  }

  await recordAudit({
    actorId: actor.staffId,
    action: decision === "APPROVED" ? "EDIT_REQUEST_APPROVED" : "EDIT_REQUEST_REJECTED",
    entity: "Staff",
    entityId: updatedRequest.staffId,
    before: { field: updatedRequest.field, status: "PENDING_HR" },
    after: { field: updatedRequest.field, status: decision },
    ...meta,
  });
  await notify({
    staffId: updatedRequest.staffId,
    type:
      decision === "APPROVED"
        ? NotificationType.EDIT_REQUEST_APPROVED
        : NotificationType.EDIT_REQUEST_REJECTED,
    message: `Your edit request for "${updatedRequest.field}" was ${decision.toLowerCase()}.`,
  });

  return updatedRequest;
}

export async function addQualification(
  actor: AuthUser,
  targetId: string,
  input: z.infer<typeof qualificationSchema>,
  meta: AuditMeta = {}
) {
  if (actor.staffId !== targetId && actor.role !== Role.HR_ADMIN) {
    throw Object.assign(new Error("forbidden"), { status: 403 });
  }
  const qualification = await prisma.staffQualification.create({ data: { staffId: targetId, ...input } });
  await recordAudit({
    actorId: actor.staffId,
    action: "QUALIFICATION_ADDED",
    entity: "StaffQualification",
    entityId: qualification.id,
    after: { type: input.type, institution: input.institution },
    ...meta,
  });
  return qualification;
}

export async function listQualifications(requester: AuthUser, targetId: string) {
  const staff = await prisma.staff.findUnique({ where: { id: targetId } });
  if (!staff) throw Object.assign(new Error("not_found"), { status: 404 });
  const allowed =
    requester.staffId === targetId ||
    requester.role === Role.HR_ADMIN ||
    (requester.role === Role.HOD && requester.departmentId === staff.departmentId);
  if (!allowed) throw Object.assign(new Error("forbidden"), { status: 403 });
  return prisma.staffQualification.findMany({ where: { staffId: targetId } });
}

/** HR/Admin only, full stop — bank/payroll data is never staff- or HOD-visible. */
export async function getBankDetails(requester: AuthUser, targetId: string) {
  if (requester.role !== Role.HR_ADMIN) {
    throw Object.assign(new Error("forbidden"), { status: 403 });
  }
  const bank = await prisma.staffBankDetail.findUnique({ where: { staffId: targetId } });
  if (!bank) return null;
  return toBankDetail(bank);
}

export async function upsertBankDetails(
  actor: AuthUser,
  targetId: string,
  input: z.infer<typeof bankDetailsSchema>,
  meta: AuditMeta = {}
) {
  if (actor.role !== Role.HR_ADMIN) {
    throw Object.assign(new Error("forbidden"), { status: 403 });
  }
  // No self-service, not even for HR/Admin — payroll disbursement destination
  // and salary grade always need a second pair of eyes; segregation of duties.
  if (actor.staffId === targetId) {
    throw Object.assign(new Error("cannot_edit_own_bank_details"), { status: 403 });
  }

  const data = {
    bankName: input.bankName,
    accountNumberEnc: encryptField(input.accountNumber),
    salaryGradeEnc: encryptField(input.salaryGrade),
    ...(input.basicSalary !== undefined ? { basicSalaryEnc: encryptField(String(input.basicSalary)) } : {}),
    ...(input.serviceAllowance !== undefined ? { serviceAllowanceEnc: encryptField(String(input.serviceAllowance)) } : {}),
    ...(input.jobAllowance !== undefined ? { jobAllowanceEnc: encryptField(String(input.jobAllowance)) } : {}),
  };
  const bank = await prisma.staffBankDetail.upsert({
    where: { staffId: targetId },
    create: { staffId: targetId, ...data },
    update: data,
  });
  await recordAudit({
    actorId: actor.staffId,
    action: "BANK_DETAILS_UPDATE",
    entity: "StaffBankDetail",
    entityId: targetId,
    after: { bankName: input.bankName, accountNumber: maskSensitive(input.accountNumber) },
    ...meta,
  });
  return toBankDetail(bank);
}

function csvCell(value: unknown): string {
  let s = String(value);
  // Neutralize CSV formula injection (Excel/Sheets treat a leading =+-@ as a
  // formula) — designation is HR-approval-gated but staff-originated via the
  // edit-request flow, so it can't be assumed benign.
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export async function exportStaffCsv(requester: AuthUser, query: ListQuery): Promise<string> {
  if (requester.role !== Role.HR_ADMIN) {
    throw Object.assign(new Error("forbidden"), { status: 403 });
  }
  const where: Record<string, unknown> = {};
  if (query.departmentId) where.departmentId = query.departmentId;
  if (query.status) where.status = query.status;
  if (query.designation) where.designation = { contains: query.designation, mode: "insensitive" };

  const staff = await prisma.staff.findMany({
    where,
    include: { department: { select: { name: true } } },
    orderBy: { fullName: "asc" },
  });

  const header = "Staff ID,Full Name,Department,Designation,Employment Type,Status,Date Joined";
  const rows = staff.map((s) =>
    [
      s.staffId,
      s.fullName,
      s.department.name,
      s.designation,
      s.employmentType,
      s.status,
      s.dateJoined.toISOString().slice(0, 10),
    ]
      .map(csvCell)
      .join(",")
  );
  return [header, ...rows].join("\n");
}
