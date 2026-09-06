import { Router, Request, Response, NextFunction } from "express";
import { Role } from "@hr/shared";
import { authenticate } from "../../lib/auth";
import { requireRole } from "../../lib/rbac";
import { requestMeta } from "../../lib/audit";
import * as service from "./service";
import {
  leaveTypeSchema,
  termCalendarSchema,
  leaveRequestSchema,
  reviewSchema,
  balanceSchema,
  calendarQuerySchema,
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

export function leaveRouter(): Router {
  const router = Router();
  router.use(authenticate);

  router.get("/types", asyncHandler(async (_req, res) => res.json(await service.listLeaveTypes())));
  router.post(
    "/types",
    requireRole(Role.HR_ADMIN),
    asyncHandler(async (req, res) => {
      const input = leaveTypeSchema.parse(req.body);
      res.status(201).json(await service.createLeaveType(req.user!, input, requestMeta(req)));
    })
  );

  router.get("/term-calendar", asyncHandler(async (_req, res) => res.json(await service.listTermCalendar())));
  router.post(
    "/term-calendar",
    requireRole(Role.HR_ADMIN),
    asyncHandler(async (req, res) => {
      const input = termCalendarSchema.parse(req.body);
      res.status(201).json(await service.createTermCalendarEntry(req.user!, input, requestMeta(req)));
    })
  );

  router.post(
    "/",
    asyncHandler(async (req, res) => {
      const input = leaveRequestSchema.parse(req.body);
      res.status(201).json(await service.submitLeaveRequest(req.user!, input, requestMeta(req)));
    })
  );

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      res.json(await service.listLeaveRequests(req.user!));
    })
  );

  router.patch(
    "/:id",
    requireRole(Role.HOD, Role.HR_ADMIN),
    asyncHandler(async (req, res) => {
      const { decision } = reviewSchema.parse(req.body);
      res.json(await service.reviewLeaveRequest(req.user!, String(req.params.id), decision, requestMeta(req)));
    })
  );

  router.get(
    "/balances/:staffId",
    asyncHandler(async (req, res) => {
      res.json(await service.getBalances(req.user!, String(req.params.staffId)));
    })
  );

  router.post(
    "/balances",
    requireRole(Role.HR_ADMIN),
    asyncHandler(async (req, res) => {
      const input = balanceSchema.parse(req.body);
      res.status(201).json(await service.setBalance(req.user!, input, requestMeta(req)));
    })
  );

  router.get(
    "/history/:staffId",
    asyncHandler(async (req, res) => {
      res.json(await service.getHistory(req.user!, String(req.params.staffId)));
    })
  );

  router.get(
    "/calendar",
    asyncHandler(async (req, res) => {
      const query = calendarQuerySchema.parse(req.query);
      res.json(await service.getCalendar(req.user!, query.departmentId, query.from, query.to));
    })
  );

  return router;
}
