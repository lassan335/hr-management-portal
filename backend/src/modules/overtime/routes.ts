import { Router, Request, Response, NextFunction } from "express";
import { Role } from "@hr/shared";
import { authenticate } from "../../lib/auth";
import { requireRole } from "../../lib/rbac";
import { requestMeta } from "../../lib/audit";
import * as service from "./service";
import { overtimeRequestSchema, reviewSchema, rateSchema, summaryQuerySchema, dashboardQuerySchema, reportQuerySchema, completeWorkSchema } from "./validation";

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

export function overtimeRouter(): Router {
  const router = Router();
  router.use(authenticate);

  router.post(
    "/",
    asyncHandler(async (req, res) => {
      const input = overtimeRequestSchema.parse(req.body);
      res.status(201).json(await service.submitRequest(req.user!, input, requestMeta(req)));
    })
  );

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      res.json(await service.listRequests(req.user!));
    })
  );

  router.patch(
    "/:id",
    requireRole(Role.HOD, Role.HR_ADMIN),
    asyncHandler(async (req, res) => {
      const { decision } = reviewSchema.parse(req.body);
      res.json(await service.reviewRequest(req.user!, String(req.params.id), decision, requestMeta(req)));
    })
  );

  router.post(
    "/:id/cancel",
    asyncHandler(async (req, res) => {
      res.json(await service.cancelRequest(req.user!, String(req.params.id), requestMeta(req)));
    })
  );

  router.post(
    "/:id/complete",
    requireRole(Role.HR_ADMIN),
    asyncHandler(async (req, res) => {
      const input = completeWorkSchema.parse(req.body);
      res.json(await service.completeWork(req.user!, String(req.params.id), input, requestMeta(req)));
    })
  );

  router.post(
    "/rates",
    requireRole(Role.HR_ADMIN),
    asyncHandler(async (req, res) => {
      const input = rateSchema.parse(req.body);
      res.status(201).json(await service.setRate(req.user!, input, requestMeta(req)));
    })
  );

  router.get(
    "/rates/:departmentId",
    asyncHandler(async (req, res) => {
      res.json(await service.getCurrentRate(req.user!, String(req.params.departmentId)));
    })
  );

  router.get(
    "/summary",
    asyncHandler(async (req, res) => {
      const query = summaryQuerySchema.parse(req.query);
      if (query.format === "csv") {
        const csv = await service.monthlySummaryCsv(req.user!, query.staffId, query.month, query.year);
        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", 'attachment; filename="overtime-summary.csv"');
        return res.send(csv);
      }
      if (query.format === "pdf") {
        const pdf = await service.monthlySummaryPdf(req.user!, query.staffId, query.month, query.year);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", 'attachment; filename="overtime-summary.pdf"');
        return res.send(pdf);
      }
      res.json(await service.monthlySummary(req.user!, query.staffId, query.month, query.year));
    })
  );

  router.get(
    "/dashboard",
    requireRole(Role.HOD, Role.HR_ADMIN),
    asyncHandler(async (req, res) => {
      const query = dashboardQuerySchema.parse(req.query);
      res.json(await service.departmentDashboard(req.user!, query.departmentId, query.month, query.year));
    })
  );

  router.get(
    "/ledger",
    requireRole(Role.HOD, Role.HR_ADMIN),
    asyncHandler(async (req, res) => {
      const query = dashboardQuerySchema.parse(req.query);
      res.json(await service.ledger(req.user!, query.departmentId, query.month, query.year));
    })
  );

  router.get(
    "/report",
    requireRole(Role.HOD, Role.HR_ADMIN),
    asyncHandler(async (req, res) => {
      const query = reportQuerySchema.parse(req.query);
      if (query.format === "pdf") {
        const pdf = await service.overtimeReportPdf(req.user!, query.departmentId, query.month, query.year);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", 'attachment; filename="overtime-report.pdf"');
        return res.send(pdf);
      }
      const xlsx = await service.overtimeReportExcel(req.user!, query.departmentId, query.month, query.year);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", 'attachment; filename="overtime-report.xlsx"');
      res.send(xlsx);
    })
  );

  return router;
}
