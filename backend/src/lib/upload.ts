import fs from "fs";
import path from "path";
import crypto from "crypto";
import multer from "multer";
import { Request, Response, Router } from "express";
import { authenticate } from "./auth";
import { canAccessStaffRecord } from "./rbac";
import { prisma } from "./prisma";

export const UPLOAD_ROOT = path.join(__dirname, "..", "..", "uploads");

/** Staff IDs are cuids (alphanumeric); reject anything else outright rather
 * than trying to sanitize it — this is a route param, not free text. */
function sanitizeStaffId(staffId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(staffId)) {
    throw new Error("invalid_staff_id");
  }
  return staffId;
}

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    try {
      const rawStaffId = (req.params.staffId || req.params.id) as string | undefined;
      const staffId = sanitizeStaffId(rawStaffId || "unassigned");
      const resolved = path.resolve(UPLOAD_ROOT, staffId);
      if (!resolved.startsWith(path.resolve(UPLOAD_ROOT) + path.sep)) {
        throw new Error("path_traversal_detected");
      }
      fs.mkdirSync(resolved, { recursive: true });
      cb(null, resolved);
    } catch (err) {
      cb(err as Error, "");
    }
  },
  filename: (_req, file, cb) => {
    const unique = crypto.randomUUID();
    // Strip directory components and any character outside a safe allowlist —
    // file.originalname is fully attacker-controlled multipart input.
    const safeName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${unique}-${safeName}`);
  },
});

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

export const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error("unsupported_file_type"));
    }
    cb(null, true);
  },
});

/**
 * Every uploaded file (documents + photos) is served ONLY through this
 * authenticated, access-checked route — never via static middleware pointed
 * at backend/uploads/, and never by a raw filesystem path a client controls.
 */
export function filesRouter(): Router {
  const router = Router();

  router.get("/:fileId", authenticate, async (req: Request, res: Response) => {
    const fileId = String(req.params.fileId);
    const doc = await prisma.staffDocument.findUnique({
      where: { id: fileId },
      include: { staff: { select: { id: true, departmentId: true } } },
    });
    if (!doc) return res.status(404).json({ error: "not_found" });

    const allowed = canAccessStaffRecord(
      req.user!,
      doc.staff.id,
      doc.staff.departmentId
    );
    if (!allowed) return res.status(403).json({ error: "forbidden" });

    if (!fs.existsSync(doc.storagePath)) {
      return res.status(404).json({ error: "file_missing_on_disk" });
    }
    // Belt-and-suspenders alongside the app-wide helmet() config — never let
    // an uploaded file be MIME-sniffed into something other than its
    // recorded type when served inline.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Type", doc.mimeType);
    res.setHeader("Content-Disposition", `inline; filename="${doc.originalName}"`);
    fs.createReadStream(doc.storagePath).pipe(res);
  });

  return router;
}
