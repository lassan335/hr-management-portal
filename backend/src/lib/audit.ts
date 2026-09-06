import type { Request } from "express";
import { prisma } from "./prisma";

/** Shared helper so every module logs request source consistently. */
export function requestMeta(req: Request): { ipAddress?: string; userAgent?: string } {
  return { ipAddress: req.ip, userAgent: req.headers["user-agent"] };
}

/** Records who did what to which entity — required on every approval/rejection
 * and every payroll/PII edit per the finsec-analyst review checklist. */
export async function recordAudit(params: {
  actorId: string | null;
  action: string;
  entity: string;
  entityId: string;
  ipAddress?: string;
  userAgent?: string;
  before?: unknown;
  after?: unknown;
}) {
  await prisma.auditLog.create({
    data: {
      actorId: params.actorId,
      action: params.action,
      entity: params.entity,
      entityId: params.entityId,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
      before: params.before as any,
      after: params.after as any,
    },
  });
}
