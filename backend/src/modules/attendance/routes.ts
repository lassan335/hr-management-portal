import fs from "fs";
import path from "path";
import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import { PunchType, Role } from "@hr/shared";
import { authenticate } from "../../lib/auth";
import { requireRole } from "../../lib/rbac";
import { requestMeta } from "../../lib/audit";
import * as service from "./service";
import {
  clockSchema,
  timesheetQuerySchema,
  dashboardQuerySchema,
  resolveUnmatchedSchema,
  correctionSchema,
  reviewSchema,
} from "./validation";

// Deliberately NOT the same directory the file-watcher monitors
// (import-watch/incoming) — sharing one folder let a manual upload and the
// watcher's own pickup race to import the same file twice (finsec review,
// T-2026-09-06-020). This upload is processed synchronously by the request
// handler below, so it never needs to be watched.
const IMPORT_DIR = path.join(__dirname, "..", "..", "..", "import-watch", "manual-uploads");

const importUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(IMPORT_DIR, { recursive: true });
      cb(null, IMPORT_DIR);
    },
    filename: (_req, file, cb) => {
      const safeName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, "_");
      cb(null, `${Date.now()}-${safeName}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (![".csv", ".xlsx", ".xls"].includes(ext)) {
      return cb(new Error("unsupported_file_type"));
    }
    cb(null, true);
  },
});

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

export function attendanceRouter(): Router {
  const router = Router();
  router.use(authenticate);

  router.post(
    "/clock",
    asyncHandler(async (req, res) => {
      const { punchType } = clockSchema.parse(req.body);
      res.status(201).json(await service.clockPunch(req.user!, punchType as PunchType | undefined));
    })
  );

  router.get(
    "/timesheet",
    asyncHandler(async (req, res) => {
      const query = timesheetQuerySchema.parse(req.query);
      if (query.format === "csv") {
        const csv = await service.exportTimesheetCsv(req.user!, query.staffId, query.from, query.to);
        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", 'attachment; filename="timesheet.csv"');
        return res.send(csv);
      }
      res.json(await service.getTimesheet(req.user!, query.staffId, query.from, query.to));
    })
  );

  router.get(
    "/dashboard",
    requireRole(Role.HOD, Role.HR_ADMIN),
    asyncHandler(async (req, res) => {
      const query = dashboardQuerySchema.parse(req.query);
      res.json(await service.getDepartmentDashboard(req.user!, query.departmentId, query.from, query.to));
    })
  );

  router.post(
    "/import",
    requireRole(Role.HR_ADMIN),
    importUpload.single("file"),
    asyncHandler(async (req, res) => {
      if (!req.file) return res.status(400).json({ error: "file required" });
      res.status(201).json(await service.importFile(req.user!, req.file.path, requestMeta(req)));
    })
  );

  router.get(
    "/sync-log",
    requireRole(Role.HR_ADMIN),
    asyncHandler(async (req, res) => {
      res.json(await service.listSyncLogs(req.user!));
    })
  );

  router.get(
    "/unmatched",
    requireRole(Role.HR_ADMIN),
    asyncHandler(async (req, res) => {
      res.json(await service.listUnmatched(req.user!));
    })
  );

  router.post(
    "/unmatched/:deviceUserId/resolve",
    requireRole(Role.HR_ADMIN),
    asyncHandler(async (req, res) => {
      const { staffId } = resolveUnmatchedSchema.parse(req.body);
      res.json(await service.resolveUnmatched(req.user!, String(req.params.deviceUserId), staffId, requestMeta(req)));
    })
  );

  router.post(
    "/corrections",
    asyncHandler(async (req, res) => {
      const input = correctionSchema.parse(req.body);
      res.status(201).json(await service.submitCorrection(req.user!, input, requestMeta(req)));
    })
  );

  router.get(
    "/corrections",
    asyncHandler(async (req, res) => {
      res.json(await service.listCorrections(req.user!));
    })
  );

  router.patch(
    "/corrections/:id",
    requireRole(Role.HOD, Role.HR_ADMIN),
    asyncHandler(async (req, res) => {
      const { decision } = reviewSchema.parse(req.body);
      res.json(await service.reviewCorrection(req.user!, String(req.params.id), decision, requestMeta(req)));
    })
  );

  return router;
}
