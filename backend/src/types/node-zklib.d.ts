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
  }
}
