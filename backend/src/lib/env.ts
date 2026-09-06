import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

// Fail CLOSED: an unset NODE_ENV must behave like production (Secure cookies,
// DEV_BYPASS_AUTH inert), never like development. Only an explicit
// NODE_ENV=development opts into dev-only behavior.
const nodeEnv = process.env.NODE_ENV ?? "production";

const jwtSecret = required("JWT_SECRET");
if (jwtSecret.length < 32) {
  throw new Error("JWT_SECRET must be at least 32 characters (256 bits) long.");
}

export const env = {
  nodeEnv,
  isProduction: nodeEnv !== "development",
  port: Number(process.env.PORT ?? 4000),

  databaseUrl: required("DATABASE_URL"),

  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  googleCallbackUrl:
    process.env.GOOGLE_CALLBACK_URL ?? "http://localhost:4000/api/auth/google/callback",
  allowedGoogleDomain: process.env.ALLOWED_GOOGLE_DOMAIN ?? "",

  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "12h",

  encryptionKey: process.env.ENCRYPTION_KEY ?? "",

  frontendOrigin: process.env.FRONTEND_ORIGIN ?? "http://localhost:5173",

  // Gated to development in code that reads this, never trust the value alone.
  devBypassAuth: process.env.DEV_BYPASS_AUTH === "true",

  smtpHost: process.env.SMTP_HOST ?? "",
  smtpPort: Number(process.env.SMTP_PORT ?? 587),
  smtpUser: process.env.SMTP_USER ?? "",
  smtpPass: process.env.SMTP_PASS ?? "",
  smtpFrom: process.env.SMTP_FROM ?? "HR Portal <no-reply@example.edu>",

  zktimeWatchDir: process.env.ZKTIME_WATCH_DIR || "",

  // Standard shift window used for late-arrival/early-departure/overtime
  // flagging in the attendance timesheet. School-wide for v1 — a
  // per-department schedule can replace this later if needed.
  shiftStart: process.env.SHIFT_START ?? "08:00",
  shiftEnd: process.env.SHIFT_END ?? "14:00",
  gracePeriodMinutes: Number(process.env.GRACE_PERIOD_MINUTES ?? 10),
  standardDailyHours: Number(process.env.STANDARD_DAILY_HOURS ?? 6),
};

if (nodeEnv !== "production") {
  console.warn(`[env] NODE_ENV=${nodeEnv} — dev-only behavior (insecure cookies, DEV_BYPASS_AUTH) may be reachable. Never run this outside a trusted local machine.`);
}

/** DEV_BYPASS_AUTH must never be honored outside development, regardless of the env value. */
export function isDevBypassAuthActive(): boolean {
  return env.nodeEnv === "development" && env.devBypassAuth;
}
