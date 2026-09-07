import { Router, Request, Response, NextFunction } from "express";
import { Role } from "@hr/shared";
import { authenticate } from "../../lib/auth";
import { requireRole } from "../../lib/rbac";
import { requestMeta } from "../../lib/audit";
import * as service from "./service";
import { periodQuerySchema, bulkQuerySchema, adjustmentSchema } from "./validation";

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

export function payrollRouter(): Router {
  const router = Router();
  router.use(authenticate);

  // HR/Admin only — the staff-picker, and the editable adjustment inputs
  // (third-party loan deductions, etc.) that back the computed slip below.
  router.get(
    "/ready",
    requireRole(Role.HR_ADMIN),
    asyncHandler(async (req, res) => {
      res.json(await service.listPayrollReadyStaff(req.user!, req.query.departmentId as string | undefined));
    })
  );

  router.get(
    "/adjustments/:staffId",
    requireRole(Role.HR_ADMIN),
    asyncHandler(async (req, res) => {
      const { month, year } = periodQuerySchema.parse(req.query);
      res.json(await service.getAdjustment(req.user!, String(req.params.staffId), month, year));
    })
  );

  router.put(
    "/adjustments/:staffId",
    requireRole(Role.HR_ADMIN),
    asyncHandler(async (req, res) => {
      const input = adjustmentSchema.parse(req.body);
      res.json(await service.upsertAdjustment(req.user!, String(req.params.staffId), input, requestMeta(req)));
    })
  );

  // HR/Admin can view anyone's slip; a staff member can view their own —
  // enforced inside computeSalarySlip/generateSalarySlipPdf, not here.
  router.get(
    "/slip/:staffId",
    asyncHandler(async (req, res) => {
      const query = periodQuerySchema.parse(req.query);
      if (query.format === "pdf") {
        const pdf = await service.generateSalarySlipPdf(req.user!, String(req.params.staffId), query.month, query.year);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", 'attachment; filename="salary-slip.pdf"');
        return res.send(pdf);
      }
      if (query.format === "excel") {
        const xlsx = await service.generateSalarySlipExcel(req.user!, String(req.params.staffId), query.month, query.year);
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", 'attachment; filename="salary-slip.xlsx"');
        return res.send(xlsx);
      }
      res.json(await service.computeSalarySlip(req.user!, String(req.params.staffId), query.month, query.year));
    })
  );

  router.get(
    "/bulk",
    requireRole(Role.HR_ADMIN),
    asyncHandler(async (req, res) => {
      const query = bulkQuerySchema.parse(req.query);
      if (query.format === "pdf") {
        const pdf = await service.generateBulkSalarySlipPdf(req.user!, query.month, query.year, query.departmentId, requestMeta(req));
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", 'attachment; filename="salary-sheet.pdf"');
        return res.send(pdf);
      }
      const xlsx = await service.generateBulkSalarySlipExcel(req.user!, query.month, query.year, query.departmentId, requestMeta(req));
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", 'attachment; filename="salary-sheet.xlsx"');
      res.send(xlsx);
    })
  );

  return router;
}
