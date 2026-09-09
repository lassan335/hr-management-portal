import { Router, Request, Response, NextFunction } from "express";
import { Role } from "@hr/shared";
import { authenticate } from "../../lib/auth";
import { requireRole, requireRoleOrSupervisor } from "../../lib/rbac";
import { requestMeta } from "../../lib/audit";
import * as service from "./service";
import {
  overtimeRequestSchema,
  assignOvertimeSchema,
  reviewSchema,
  rateSchema,
  summaryQuerySchema,
  dashboardQuerySchema,
  reportQuerySchema,
  completeWorkSchema,
  reportCompletionSchema,
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

  // Any authenticated staff member — picking a reviewer at submission is a
  // self-service step, not gated behind canSupervise/HOD/HR_ADMIN like the
  // full staff directory (GET /api/staff).
  router.get(
    "/supervisors",
    asyncHandler(async (req, res) => {
      res.json(await service.listSupervisors(req.user!));
    })
  );

  // Fine-grained authorization (Staff.canSupervise, independent of `role`)
  // happens inside the service — most real staff, including the actual
  // principal/admins, currently carry plain role STAFF.
  router.post(
    "/assign",
    asyncHandler(async (req, res) => {
      const input = assignOvertimeSchema.parse(req.body);
      res.status(201).json(await service.assignTask(req.user!, input, requestMeta(req)));
    })
  );

  // Staff.canSupervise (independent of `role`) must be let through here too
  // now — a self-submitted request's reviewer is whichever supervisor the
  // staff member picked (see submitRequest/listSupervisors), who very often
  // carries plain role STAFF. Fine-grained checks (must be the SPECIFIC
  // selected supervisor, or HR_ADMIN) happen inside reviewRequest.
  router.patch(
    "/:id",
    requireRoleOrSupervisor(Role.HOD, Role.HR_ADMIN),
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

  // The request owner reports the actual time they worked, once approved —
  // the normal completion path (see reportOvertimeCompletion's doc comment).
  // Ownership is checked inside the service, not here.
  router.post(
    "/:id/report-time",
    asyncHandler(async (req, res) => {
      const input = reportCompletionSchema.parse(req.body);
      res.json(await service.reportOvertimeCompletion(req.user!, String(req.params.id), input, requestMeta(req)));
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

  router.get(
    "/report/individual",
    requireRole(Role.HOD, Role.HR_ADMIN),
    asyncHandler(async (req, res) => {
      const query = dashboardQuerySchema.parse(req.query);
      const xlsx = await service.individualOtDetailsExcel(req.user!, query.departmentId, query.month, query.year);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", 'attachment; filename="individual-staff-ot-details.xlsx"');
      res.send(xlsx);
    })
  );

  return router;
}
