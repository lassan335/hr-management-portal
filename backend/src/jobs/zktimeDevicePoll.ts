import ZKLib from "node-zklib";
import { REQUEST_DATA } from "node-zklib/constants";
import { decodeRecordData40 } from "node-zklib/utils";
import { AttendanceSource, NotificationType, PunchType, Role } from "@hr/shared";
import { env } from "../lib/env";
import { prisma } from "../lib/prisma";
import { recordAudit } from "../lib/audit";
import { notify } from "../lib/notifications";
import { importDevicePunchesBatched, ParsedPunch } from "./zktimeImport";

interface RawAttendanceRecord {
  deviceUserId: string;
  recordTime: Date;
  /** Firmware-standard punch-type code (see STATUS_CODE_TO_PUNCH_TYPE) —
   * present in every raw 40-byte attendance record the device sends, but
   * silently discarded by node-zklib's own decodeRecordData40 (it only
   * reads userSn/deviceUserId/recordTime out of the buffer). Confirmed by
   * reading the live device's raw bytes directly: byte offset 31 (right
   * after the 4-byte recordTime at 27-31) holds an evenly-distributed 0-5
   * value matching this exact convention, on every record — bytes 11-27 are
   * always zero (unused in this firmware), so nothing else in the record
   * carries this. */
  statusCode: number;
}

/**
 * Re-implements ZKLibTCP.getAttendances() (node_modules/node-zklib/zklibtcp.js)
 * ourselves instead of calling it, purely to keep the status byte its own
 * decoder throws away. `zk.zklibTcp` is the same internal transport instance
 * getAttendances() would use — createSocket() must have already run so
 * zk.connectionType is "tcp" (the only transport this app's device polling
 * ever uses; UDP isn't wired up anywhere in this job).
 */
async function readRawAttendanceLogs(zk: ZKLib): Promise<RawAttendanceRecord[]> {
  if (zk.connectionType !== "tcp") {
    throw new Error(`unexpected_connection_type:${zk.connectionType}`);
  }
  const tcp = zk.zklibTcp;
  if (tcp.socket) await tcp.freeData();
  const data = await tcp.readWithBuffer(REQUEST_DATA.GET_ATTENDANCE_LOGS);
  if (tcp.socket) await tcp.freeData();

  const RECORD_PACKET_SIZE = 40;
  let recordData = data.data.subarray(4);
  const records: RawAttendanceRecord[] = [];
  while (recordData.length >= RECORD_PACKET_SIZE) {
    const chunk = recordData.subarray(0, RECORD_PACKET_SIZE);
    const base = decodeRecordData40(chunk);
    records.push({ deviceUserId: base.deviceUserId, recordTime: base.recordTime, statusCode: chunk.readUInt8(31) });
    recordData = recordData.subarray(RECORD_PACKET_SIZE);
  }
  return records;
}

// Firmware-standard punch-type codes — matches the numeric convention
// zktimeImport.ts's PUNCH_TYPE_VALUES already documents for ZKTime 5.0
// CSV/xlsx exports' status column, since it's the same underlying firmware
// convention either way.
const STATUS_CODE_TO_PUNCH_TYPE: Record<number, PunchType> = {
  0: PunchType.CHECK_IN,
  1: PunchType.CHECK_OUT,
  2: PunchType.BREAK_OUT,
  3: PunchType.BREAK_IN,
  4: PunchType.OVERTIME_IN,
  5: PunchType.OVERTIME_OUT,
};

/**
 * Maps each raw record's genuine device-reported punch type directly —
 * no more guessing direction from position within the day (which
 * mislabeled, e.g., a real trailing Break Out as a Check Out any time the
 * matching Break In tap never came). An unrecognized status code (should
 * never happen given the confirmed 0-5 range, but firmware is firmware)
 * falls back to strict per-device-per-day alternation, same as
 * zktimeImport.ts's own status-less fallback for bare punch-log exports.
 */
function toRealPunches(logs: RawAttendanceRecord[]): ParsedPunch[] {
  const sorted = logs
    // The device pads its log buffer with empty/sentinel rows
    // (deviceUserId: "", recordTime at its zero-date) — skip those.
    .filter((log) => log.deviceUserId && !isNaN(log.recordTime?.getTime?.()))
    .sort((a, b) => a.recordTime.getTime() - b.recordTime.getTime());

  const fallbackIndexByDay = new Map<string, number>();
  return sorted.map((log) => {
    const punchType = STATUS_CODE_TO_PUNCH_TYPE[log.statusCode];
    if (punchType) return { deviceUserId: log.deviceUserId, timestamp: log.recordTime, punchType };

    const dayKey = `${log.deviceUserId}:${log.recordTime.toISOString().slice(0, 10)}`;
    const idx = fallbackIndexByDay.get(dayKey) ?? 0;
    fallbackIndexByDay.set(dayKey, idx + 1);
    return {
      deviceUserId: log.deviceUserId,
      timestamp: log.recordTime,
      punchType: idx % 2 === 0 ? PunchType.CHECK_IN : PunchType.CHECK_OUT,
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
    const logs = await readRawAttendanceLogs(zk);
    const punches = toRealPunches(logs);
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
