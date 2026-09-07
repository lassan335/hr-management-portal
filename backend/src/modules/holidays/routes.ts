import { Router, Request, Response, NextFunction } from "express";
import { Role } from "@hr/shared";
import { authenticate } from "../../lib/auth";
import { requireRole } from "../../lib/rbac";
import { requestMeta } from "../../lib/audit";
import * as service from "./service";
import { createHolidaySchema, listHolidaysQuerySchema } from "./validation";

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

export function holidaysRouter(): Router {
  const router = Router();
  router.use(authenticate);

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const query = listHolidaysQuerySchema.parse(req.query);
      res.json(await service.listHolidays(query.from, query.to));
    })
  );

  router.post(
    "/",
    requireRole(Role.HR_ADMIN),
    asyncHandler(async (req, res) => {
      const input = createHolidaySchema.parse(req.body);
      res.status(201).json(await service.createHoliday(req.user!, input, requestMeta(req)));
    })
  );

  router.delete(
    "/:id",
    requireRole(Role.HR_ADMIN),
    asyncHandler(async (req, res) => {
      res.json(await service.deleteHoliday(req.user!, String(req.params.id), requestMeta(req)));
    })
  );

  return router;
}
