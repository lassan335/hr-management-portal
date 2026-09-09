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
 * A 2026-09-09 investigation tried reading a byte at offset 31 of the raw
 * 40-byte attendance record, believing it to be a genuine device-reported
 * punch-type code (it does vary 0-5 across real records). Cross-checked
 * against an authoritative ZKTime 5.0 "State" export for one day, that byte
 * disagreed with the real Check/Break/OT classification on ~45% of staff —
 * the real classification is computed by the desktop software's own
 * session/schedule logic, not read from a fixed byte position. Do not
 * reintroduce raw-byte decoding without validating it against a real export
 * first.
 *
 * A session/schedule model (Check In 6-8am, Check Out >=12:45pm, OT session
 * state carried indefinitely across midnight) replaced that, and looked
 * good (~89%) against that same single day. It wasn't: cross-checked
 * against the actual ZKTime 5.0 database's own already-classified punch log
 * (CHECKINOUT.CHECKTYPE — confirmed authoritative: 'I'/'O' Check In/Out,
 * '0'/'1' Break Out/In, lowercase 'i'/'o' Overtime In/Out) over 5 weeks and
 * 46 staff, real accuracy was ~53%. Two problems the single day never
 * exercised:
 *   1. On a non-working day (Fri/Sat — see holidays/service.ts's weekend
 *      rule), staff who come in only for OT have no Check In/Out at all
 *      that day; every punch is OT. The old model always treated a day's
 *      first punch as Check In.
 *   2. Carrying state indefinitely across midnight means a single missed
 *      or malformed punch on any one day desyncs every day after it for
 *      that person, forever — a single-day test can't see this at all.
 * Fixed by (1) treating every punch on a non-working day as Overtime
 * in/out, and (2) resetting state at each calendar-day boundary instead of
 * carrying it indefinitely — trading away genuine cross-midnight OT
 * spanning (rare) for immunity to that cascade (not rare, and far more
 * costly). Re-validated against the same 5-week/46-staff CHECKINOUT data:
 * ~86% punch-level, 75% of individual days fully correct. Re-validate
 * against a similarly large, real, multi-week sample (a single day is not
 * sufficient — see above) before changing this again.
 */
type SessionState = "BEFORE_CHECKIN" | "IN_SESSION" | "IN_OT_WINDOW";

function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

const CHECKIN_WINDOW_START = minutesOfDay(env.zktimeDevice.checkinWindowStart);
const CHECKIN_WINDOW_END = minutesOfDay(env.zktimeDevice.checkinWindowEnd);
const CHECKOUT_THRESHOLD = minutesOfDay(env.zktimeDevice.checkoutTime);

/** Sunday-Thursday, matching the same Maldives weekend rule used
 * school-wide (see holidays/service.ts's resolveDayType) — Friday/Saturday
 * are never a normal Check In/Out day here, only Overtime. */
function isWorkingDay(date: Date): boolean {
  const dayOfWeek = date.getDay();
  return dayOfWeek >= 0 && dayOfWeek <= 4;
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function toSessionPunches(logs: ZKAttendanceRecord[]): ParsedPunch[] {
  const sorted = logs
    // The device pads its log buffer with empty/sentinel rows
    // (deviceUserId: "", recordTime at its zero-date) — skip those.
    .filter((log) => log.deviceUserId && !isNaN(log.recordTime?.getTime?.()))
    .sort((a, b) => a.recordTime.getTime() - b.recordTime.getTime());

  const byDevice = new Map<string, ZKAttendanceRecord[]>();
  for (const log of sorted) {
    if (!byDevice.has(log.deviceUserId)) byDevice.set(log.deviceUserId, []);
    byDevice.get(log.deviceUserId)!.push(log);
  }

  const punches: ParsedPunch[] = [];
  for (const logsForDevice of byDevice.values()) {
    // State resets at every calendar-day boundary (see this function's doc
    // comment) — deliberately NOT carried indefinitely across days.
    let currentDay: string | null = null;
    let state: SessionState = "BEFORE_CHECKIN";
    let onBreak = false;
    let otOpen = false;

    for (const log of logsForDevice) {
      const key = dayKey(log.recordTime);
      if (key !== currentDay) {
        currentDay = key;
        state = "BEFORE_CHECKIN";
        onBreak = false;
        otOpen = false;
      }

      const working = isWorkingDay(log.recordTime);
      const mins = log.recordTime.getHours() * 60 + log.recordTime.getMinutes();
      const inCheckinWindow = working && mins >= CHECKIN_WINDOW_START && mins < CHECKIN_WINDOW_END;
      let punchType: PunchType;

      if (state === "BEFORE_CHECKIN") {
        if (working) {
          punchType = PunchType.CHECK_IN;
          state = "IN_SESSION";
          onBreak = false;
        } else {
          // Non-working day (Fri/Sat) — no normal session exists to open;
          // every punch that day is Overtime.
          punchType = PunchType.OVERTIME_IN;
          state = "IN_OT_WINDOW";
          otOpen = true;
        }
      } else if (state === "IN_SESSION") {
        if (!onBreak) {
          if (mins >= CHECKOUT_THRESHOLD) {
            punchType = PunchType.CHECK_OUT;
            state = "IN_OT_WINDOW";
            otOpen = false;
          } else {
            punchType = PunchType.BREAK_OUT;
            onBreak = true;
          }
        } else {
          punchType = PunchType.BREAK_IN;
          onBreak = false;
        }
      } else {
        // IN_OT_WINDOW — a punch inside the Check-In window on a working
        // day always starts a fresh session, even over a still-open OT
        // pair (matches the real classification: an unclosed OT pair
        // simply never gets its Out tap rather than blocking Check In).
        if (inCheckinWindow) {
          punchType = PunchType.CHECK_IN;
          state = "IN_SESSION";
          onBreak = false;
        } else if (!otOpen) {
          punchType = PunchType.OVERTIME_IN;
          otOpen = true;
        } else {
          punchType = PunchType.OVERTIME_OUT;
          otOpen = false;
        }
      }

      punches.push({ deviceUserId: log.deviceUserId, timestamp: log.recordTime, punchType });
    }
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
    const punches = toSessionPunches(logs);
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
