import fs from "fs";
import path from "path";
import chokidar from "chokidar";
import { NotificationType, Role } from "@hr/shared";
import { env } from "../lib/env";
import { prisma } from "../lib/prisma";
import { recordAudit } from "../lib/audit";
import { notify } from "../lib/notifications";
import { processZKTimeFile } from "./zktimeImport";

const DEFAULT_WATCH_DIR = path.join(__dirname, "..", "..", "import-watch", "incoming");
const PROCESSED_SUBDIR = "processed";
const FAILED_SUBDIR = "failed";

/**
 * Watches the ZKTime export drop folder and imports any new file that lands
 * there, then moves it into incoming/processed/ (or incoming/failed/ if
 * parsing/import failed) so it's never reprocessed. The admin manual-upload
 * endpoint (attendance/routes.ts) writes to a separate, unwatched directory
 * and calls processZKTimeFile() directly — the two paths used to share this
 * folder, which let a manual upload and the watcher race to import the same
 * file twice (finsec review, T-2026-09-06-020).
 */
export function startZktimeWatcher() {
  const watchDir = env.zktimeWatchDir || DEFAULT_WATCH_DIR;
  const processedDir = path.join(watchDir, PROCESSED_SUBDIR);
  const failedDir = path.join(watchDir, FAILED_SUBDIR);
  fs.mkdirSync(watchDir, { recursive: true });
  fs.mkdirSync(processedDir, { recursive: true });
  fs.mkdirSync(failedDir, { recursive: true });

  const watcher = chokidar.watch(watchDir, {
    // Path-segment-aware, not a substring match — a substring check would
    // also skip a legitimately-named file like "unprocessed_jan.csv".
    ignored: (p) => {
      const rel = path.relative(watchDir, p);
      const firstSegment = rel.split(path.sep)[0];
      return firstSegment === PROCESSED_SUBDIR || firstSegment === FAILED_SUBDIR;
    },
    depth: 0,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 },
  });

  watcher.on("add", async (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (![".csv", ".xlsx", ".xls"].includes(ext)) return;

    let succeeded = false;
    try {
      const result = await processZKTimeFile(filePath, null);
      succeeded = true;
      if (result.duplicate) {
        console.log(`[zktime-watcher] ${path.basename(filePath)} matches a previously-imported file (hash match) — skipped.`);
      } else {
        console.log(
          `[zktime-watcher] Imported ${path.basename(filePath)}: ${result.processedCount} processed, ${result.matchedCount} matched, ${result.unmatchedCount} unmatched.`
        );
      }
    } catch (err) {
      console.error(`[zktime-watcher] Failed to import ${filePath}:`, err);
      await recordAudit({
        actorId: null,
        action: "ATTENDANCE_IMPORT_FAILED",
        entity: "AttendanceSyncLog",
        entityId: path.basename(filePath),
        after: { error: (err as Error).message },
      });
      const hrAdmins = await prisma.staff.findMany({ where: { role: Role.HR_ADMIN }, select: { id: true } });
      for (const hr of hrAdmins) {
        await notify({
          staffId: hr.id,
          type: NotificationType.ATTENDANCE_IMPORT_FAILED,
          message: `ZKTime import failed for "${path.basename(filePath)}": ${(err as Error).message}`,
        });
      }
    } finally {
      const destDir = succeeded ? processedDir : failedDir;
      const dest = path.join(destDir, `${Date.now()}-${path.basename(filePath)}`);
      if (fs.existsSync(filePath)) fs.renameSync(filePath, dest);
    }
  });

  console.log(`[zktime-watcher] Watching ${watchDir} for ZKTime 5.0 exports.`);
  return watcher;
}
