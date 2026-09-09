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
 * sync" cursor — every poll re-reads the device's full in-memory log, and
 * importDevicePunchesBatched skips punches already recorded from an earlier
 * poll instead of re-inserting them every time.
 *
 * Direction/type is inferred from position within each device+day's
 * chronological sequence, the same way the real ZKTime 5.0 software's own
 * "Schedule Class" mechanism works (confirmed by reading its shipped SQL
 * schema — its raw punch table is *also* just a 2-state In/Out flag; Break
 * detection there is a calculated gap between sessions, not a device-
 * reported type either): the first punch of the day opens it (CHECK_IN),
 * the last one closes it (CHECK_OUT), and any punches in between are the
 * boundaries of a break (BREAK_OUT/BREAK_IN, alternating). A day with only
 * 2 punches behaves exactly as before (CHECK_IN, CHECK_OUT); a day with an
 * odd punch count ends on a BREAK_IN with no closing CHECK_OUT, correctly
 * surfacing as missingCheckout rather than being guessed at.
 */
function toAlternatingPunches(logs: ZKAttendanceRecord[]): ParsedPunch[] {
  const sorted = logs
    // The device pads its log buffer with empty/sentinel rows
    // (deviceUserId: "", recordTime at its zero-date) — skip those.
    .filter((log) => log.deviceUserId && !isNaN(log.recordTime?.getTime?.()))
    .sort((a, b) => a.recordTime.getTime() - b.recordTime.getTime());

  const dayGroups = new Map<string, ZKAttendanceRecord[]>();
  for (const log of sorted) {
    const dayKey = `${log.deviceUserId}:${log.recordTime.toISOString().slice(0, 10)}`;
    if (!dayGroups.has(dayKey)) dayGroups.set(dayKey, []);
    dayGroups.get(dayKey)!.push(log);
  }

  const punches: ParsedPunch[] = [];
  for (const group of dayGroups.values()) {
    group.forEach((log, i) => {
      const isLast = i === group.length - 1;
      let punchType: PunchType;
      if (i === 0) {
        punchType = PunchType.CHECK_IN;
      } else if (i % 2 === 1) {
        // An "out" position — closes the day if nothing follows, otherwise opens a break.
        punchType = isLast ? PunchType.CHECK_OUT : PunchType.BREAK_OUT;
      } else {
        // An "in" position after the first punch is always a return from break.
        punchType = PunchType.BREAK_IN;
      }
      punches.push({ deviceUserId: log.deviceUserId, timestamp: log.recordTime, punchType });
    });
  }
  return punches;
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
    // Reporting the failure (audit log + HR notification) needs the same
    // database the poll itself just failed to reach — e.g. the DB was
    // transiently unreachable (a paused Supabase project waking up). That
    // must never throw past this catch: an uncaught rejection here would
    // crash the whole server over what's otherwise a one-off missed poll
    // that the next interval will just retry.
    try {
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
    } catch (reportingErr) {
      console.error("[zktime-device] Also failed to record/report the poll failure:", reportingErr);
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
