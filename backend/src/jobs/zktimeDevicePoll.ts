import ZKLib, { ZKAttendanceRecord } from "node-zklib";
import { AttendanceSource, NotificationType, PunchType, Role } from "@hr/shared";
import { env } from "../lib/env";
import { prisma } from "../lib/prisma";
import { recordAudit } from "../lib/audit";
import { notify } from "../lib/notifications";
import { importDevicePunchesBatched, ParsedPunch } from "./zktimeImport";

/**
 * The device's TCP protocol has no punch-direction field (unlike a ZKTime
 * 5.0 CSV/xlsx export, which usually has a status column) and no "since last
 * sync" cursor — every poll re-reads the device's full in-memory log. So
 * direction is inferred the same way the file importer falls back to when an
 * export has no status column (strict Check In/Check Out alternation per
 * device per day, ordered by time), and importDevicePunchesBatched skips
 * punches already recorded from an earlier poll instead of re-inserting them
 * every time.
 */
function toAlternatingPunches(logs: ZKAttendanceRecord[]): ParsedPunch[] {
  const sorted = logs
    // The device pads its log buffer with empty/sentinel rows
    // (deviceUserId: "", recordTime at its zero-date) — skip those.
    .filter((log) => log.deviceUserId && !isNaN(log.recordTime?.getTime?.()))
    .sort((a, b) => a.recordTime.getTime() - b.recordTime.getTime());

  const dayIndexByDeviceDay = new Map<string, number>();
  return sorted.map((log) => {
    const dayKey = `${log.deviceUserId}:${log.recordTime.toISOString().slice(0, 10)}`;
    const idxInDay = dayIndexByDeviceDay.get(dayKey) ?? 0;
    dayIndexByDeviceDay.set(dayKey, idxInDay + 1);
    return {
      deviceUserId: log.deviceUserId,
      timestamp: log.recordTime,
      punchType: idxInDay % 2 === 0 ? PunchType.CHECK_IN : PunchType.CHECK_OUT,
    };
  });
}

let polling = false;

async function pollOnce() {
  if (polling) return; // guard against overlap if a poll ever runs long
  polling = true;
  const zk = new ZKLib(env.zktimeDevice.ip, env.zktimeDevice.port, 10000, 4000);
  try {
    await zk.createSocket();
    const { data: logs } = await zk.getAttendances();
    const punches = toAlternatingPunches(logs);
    if (punches.length === 0) {
      console.log(`[zktime-device] Polled ${env.zktimeDevice.ip}: no punches on device.`);
      return;
    }

    const result = await importDevicePunchesBatched(punches, {
      fileName: `device-poll-${new Date().toISOString()}`,
      source: AttendanceSource.DEVICE,
    });
    console.log(
      `[zktime-device] Polled ${env.zktimeDevice.ip}: ${result.processedCount} on device, ${result.matchedCount} newly matched, ${result.unmatchedCount} newly unmatched.`
    );
  } catch (err) {
    console.error("[zktime-device] Poll failed:", err);
    await recordAudit({
      actorId: null,
      action: "ATTENDANCE_DEVICE_POLL_FAILED",
      entity: "AttendanceSyncLog",
      entityId: env.zktimeDevice.ip,
      after: { error: (err as Error).message },
    });
    const hrAdmins = await prisma.staff.findMany({ where: { role: Role.HR_ADMIN }, select: { id: true } });
    for (const hr of hrAdmins) {
      await notify({
        staffId: hr.id,
        type: NotificationType.ATTENDANCE_IMPORT_FAILED,
        message: `ZKTime device poll failed (${env.zktimeDevice.ip}): ${(err as Error).message}`,
      });
    }
  } finally {
    try {
      await zk.disconnect();
    } catch {
      // never connected, or the device already dropped the socket — nothing to clean up
    }
    polling = false;
  }
}

export function startZktimeDevicePoll() {
  if (!env.zktimeDevice.enabled) return;
  console.log(
    `[zktime-device] Polling ${env.zktimeDevice.ip}:${env.zktimeDevice.port} every ${env.zktimeDevice.pollIntervalMinutes} min.`
  );
  void pollOnce();
  setInterval(() => void pollOnce(), env.zktimeDevice.pollIntervalMinutes * 60 * 1000);
}
