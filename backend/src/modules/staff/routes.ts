import { Router, Request, Response, NextFunction } from "express";
import { DocumentType, Role } from "@hr/shared";
import { authenticate } from "../../lib/auth";
import { requireRole, requireRoleOrSupervisor } from "../../lib/rbac";
import { upload } from "../../lib/upload";
import { prisma } from "../../lib/prisma";
import { recordAudit, requestMeta } from "../../lib/audit";
import * as service from "./service";
import {
  createStaffSchema,
  adminUpdateStaffSchema,
  selfUpdateSchema,
  editRequestSchema,
  reviewEditRequestSchema,
  statusChangeSchema,
  qualificationSchema,
  bankDetailsSchema,
  staffListQuerySchema,
  documentTypeSchema,
} from "./validation";

function asyncHandler(fn: (req: Request, res: Response) => Promise<void | Response>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch((err) => {
      if (err && typeof err.status === "number") {
        return res.status(err.status).json({ error: err.message });
      }
      next(err);
    });
  };
}

export function staffRouter(): Router {
  const router = Router();
  router.use(authenticate);

  router.get(
    "/",
    requireRoleOrSupervisor(Role.HR_ADMIN, Role.HOD),
    asyncHandler(async (req, res) => {
      const query = staffListQuerySchema.parse(req.query);
      if (query.format === "csv") {
        const csv = await service.exportStaffCsv(req.user!, query);
        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", 'attachment; filename="staff-directory.csv"');
        return res.send(csv);
      }
      res.json(await service.listStaff(req.user!, query));
    })
  );

  router.get(
    "/me",
    asyncHandler(async (req, res) => {
      res.json(await service.getStaffDetail(req.user!, req.user!.staffId));
    })
  );

  router.patch(
    "/me",
    asyncHandler(async (req, res) => {
      const patch = selfUpdateSchema.parse(req.body);
      res.json(await service.selfUpdateStaff(req.user!, patch, requestMeta(req)));
    })
  );

  router.post(
    "/",
    requireRole(Role.HR_ADMIN),
    asyncHandler(async (req, res) => {
      const input = createStaffSchema.parse(req.body);
      res.status(201).json(await service.createStaff(req.user!, input, requestMeta(req)));
    })
  );

  router.get(
    "/departments",
    asyncHandler(async (_req, res) => {
      res.json(await service.listDepartments());
    })
  );

  router.get(
    "/edit-requests",
    asyncHandler(async (req, res) => {
      res.json(await service.listEditRequests(req.user!));
    })
  );

  router.patch(
    "/edit-requests/:requestId",
    requireRole(Role.HR_ADMIN),
    asyncHandler(async (req, res) => {
      const { decision } = reviewEditRequestSchema.parse(req.body);
      res.json(await service.reviewEditRequest(req.user!, String(req.params.requestId), decision, requestMeta(req)));
    })
  );

  router.get(
    "/:id",
    asyncHandler(async (req, res) => {
      res.json(await service.getStaffDetail(req.user!, String(req.params.id)));
    })
  );

  router.patch(
    "/:id",
    requireRole(Role.HR_ADMIN),
    asyncHandler(async (req, res) => {
      const input = adminUpdateStaffSchema.parse(req.body);
      res.json(await service.adminUpdateStaff(req.user!, String(req.params.id), input, requestMeta(req)));
    })
  );

  router.patch(
    "/:id/status",
    requireRole(Role.HR_ADMIN),
    asyncHandler(async (req, res) => {
      const input = statusChangeSchema.parse(req.body);
      res.json(await service.changeStatus(req.user!, String(req.params.id), input, requestMeta(req)));
    })
  );

  router.get(
    "/:id/status-history",
    asyncHandler(async (req, res) => {
      res.json(await service.getStatusHistory(req.user!, String(req.params.id)));
    })
  );

  router.post(
    "/:id/edit-requests",
    asyncHandler(async (req, res) => {
      const input = editRequestSchema.parse(req.body);
      res.status(201).json(await service.submitEditRequest(req.user!, String(req.params.id), input, requestMeta(req)));
    })
  );

  router.get(
    "/:id/qualifications",
    asyncHandler(async (req, res) => {
      res.json(await service.listQualifications(req.user!, String(req.params.id)));
    })
  );

  router.post(
    "/:id/qualifications",
    asyncHandler(async (req, res) => {
      const input = qualificationSchema.parse(req.body);
      res.status(201).json(await service.addQualification(req.user!, String(req.params.id), input, requestMeta(req)));
    })
  );

  router.get(
    "/:id/bank-details",
    requireRole(Role.HR_ADMIN),
    asyncHandler(async (req, res) => {
      res.json(await service.getBankDetails(req.user!, String(req.params.id)));
    })
  );

  router.put(
    "/:id/bank-details",
    requireRole(Role.HR_ADMIN),
    asyncHandler(async (req, res) => {
      const input = bankDetailsSchema.parse(req.body);
      res.json(await service.upsertBankDetails(req.user!, String(req.params.id), input, requestMeta(req)));
    })
  );

  router.get(
    "/:id/documents",
    asyncHandler(async (req, res) => {
      const targetId = String(req.params.id);
      const staff = await prisma.staff.findUnique({ where: { id: targetId } });
      if (!staff) return res.status(404).json({ error: "not_found" });
      const allowed =
        req.user!.staffId === targetId ||
        req.user!.role === Role.HR_ADMIN ||
        (req.user!.role === Role.HOD && req.user!.departmentId === staff.departmentId);
      if (!allowed) return res.status(403).json({ error: "forbidden" });
      const docs = await prisma.staffDocument.findMany({ where: { staffId: targetId } });
      res.json(docs.map((d) => ({ id: d.id, docType: d.docType, originalName: d.originalName, uploadedAt: d.uploadedAt })));
    })
  );

  router.post(
    "/:id/documents",
    // Ownership check runs BEFORE multer writes anything to disk — otherwise
    // an authenticated non-owner could get a file written into another
    // staff member's upload folder before the handler below ever runs.
    (req, res, next) => {
      const targetId = String(req.params.id);
      if (req.user!.staffId !== targetId && req.user!.role !== Role.HR_ADMIN) {
        return res.status(403).json({ error: "forbidden" });
      }
      next();
    },
    upload.single("file"),
    asyncHandler(async (req, res) => {
      const targetId = String(req.params.id);
      const file = req.file;
      if (!file) return res.status(400).json({ error: "file required" });
      const docTypeParse = documentTypeSchema.safeParse(req.body.docType || "OTHER");
      if (!docTypeParse.success) return res.status(400).json({ error: "invalid docType" });
      const docType = docTypeParse.data;

      const doc = await prisma.staffDocument.create({
        data: {
          staffId: targetId,
          docType,
          originalName: file.originalname,
          mimeType: file.mimetype,
          sizeBytes: file.size,
          storagePath: file.path,
          uploadedBy: req.user!.staffId,
        },
      });

      if (docType === DocumentType.PHOTO) {
        await prisma.staff.update({ where: { id: targetId }, data: { photoDocumentId: doc.id } });
      }
      await recordAudit({
        actorId: req.user!.staffId,
        action: "DOCUMENT_UPLOAD",
        entity: "StaffDocument",
        entityId: doc.id,
        after: { docType, originalName: file.originalname },
        ...requestMeta(req),
      });
      res.status(201).json({ id: doc.id, docType: doc.docType, originalName: doc.originalName });
    })
  );

  return router;
}
