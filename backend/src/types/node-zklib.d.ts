// node-zklib ships no type declarations of its own.
declare module "node-zklib" {
  export interface ZKAttendanceRecord {
    userSn: number;
    deviceUserId: string;
    recordTime: Date;
    ip: string;
  }

  export interface ZKUser {
    uid: number;
    role: number;
    password: string;
    name: string;
    cardno: number;
    userId: string;
  }

  export default class ZKLib {
    constructor(ip: string, port: number, timeout: number, inport: number);
    createSocket(): Promise<void>;
    disconnect(): Promise<void>;
    getInfo(): Promise<{ userCounts: number; logCounts: number; logCapacity: number }>;
    getUsers(): Promise<{ data: ZKUser[]; err?: unknown }>;
    getAttendances(
      progress?: (received: number, total: number) => void
    ): Promise<{ data: ZKAttendanceRecord[]; err?: unknown }>;
    /** Set by createSocket() once connected — "tcp" for every real device
     * this app talks to (getAttendances() only implements TCP transport
     * error paths, not UDP). Exposed here because zktimeDevicePoll.ts reads
     * the raw attendance log itself (via zklibTcp below) to recover the
     * punch-type byte getAttendances()/decodeRecordData40 silently discard —
     * see that file's doc comment for why. */
    connectionType: "tcp" | "udp" | null;
    /** The library's internal TCP transport (node_modules/node-zklib/zklibtcp.js)
     * — not part of node-zklib's public API, but a plain public class field,
     * so it's reachable from here. */
    zklibTcp: {
      socket: unknown;
      freeData(): Promise<unknown>;
      readWithBuffer(
        reqData: Buffer,
        progress?: (received: number, total: number) => void
      ): Promise<{ data: Buffer; err?: unknown }>;
    };
  }
}

// The two internal modules zktimeDevicePoll.ts pulls in directly to recover
// the raw punch-type byte — see this file's ZKLib.zklibTcp doc comment.
declare module "node-zklib/constants" {
  export const REQUEST_DATA: { GET_ATTENDANCE_LOGS: Buffer };
}

declare module "node-zklib/utils" {
  export function decodeRecordData40(recordData: Buffer): {
    userSn: number;
    deviceUserId: string;
    recordTime: Date;
  };
}
