import fs from "fs";
import path from "path";
import chokidar from "chokidar";
import { env } from "../lib/env";
import { processZKTimeFile } from "./zktimeImport";

const DEFAULT_WATCH_DIR = path.join(__dirname, "..", "..", "import-watch", "incoming");
const PROCESSED_SUBDIR = "processed";

/**
 * Watches the ZKTime export drop folder and imports any new file that lands
 * there, then moves it into incoming/processed/ so it's never reprocessed.
 * The admin manual-upload endpoint (attendance/routes.ts) calls
 * processZKTimeFile() directly instead of going through this watcher.
 */
export function startZktimeWatcher() {
  const watchDir = env.zktimeWatchDir || DEFAULT_WATCH_DIR;
  const processedDir = path.join(watchDir, PROCESSED_SUBDIR);
  fs.mkdirSync(watchDir, { recursive: true });
  fs.mkdirSync(processedDir, { recursive: true });

  const watcher = chokidar.watch(watchDir, {
    ignored: (p) => p.includes(PROCESSED_SUBDIR),
    depth: 0,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 },
  });

  watcher.on("add", async (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (![".csv", ".xlsx", ".xls"].includes(ext)) return;

    try {
      const result = await processZKTimeFile(filePath, null);
      console.log(
        `[zktime-watcher] Imported ${path.basename(filePath)}: ${result.processedCount} processed, ${result.matchedCount} matched, ${result.unmatchedCount} unmatched.`
      );
    } catch (err) {
      console.error(`[zktime-watcher] Failed to import ${filePath}:`, err);
    } finally {
      const dest = path.join(processedDir, `${Date.now()}-${path.basename(filePath)}`);
      fs.renameSync(filePath, dest);
    }
  });

  console.log(`[zktime-watcher] Watching ${watchDir} for ZKTime 5.0 exports.`);
  return watcher;
}
