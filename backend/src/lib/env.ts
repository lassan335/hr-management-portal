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

  // Fallback shift window for staff not assigned to a StaffGroup — real
  // scheduling (sign-in time + working hours) comes from the staff's group
  // (see prisma schema's StaffGroup model), matching the legacy portal's
  // "Staff Groups" concept (e.g. New Framework: 06:45/8h, Old Framework:
  // 06:45/6h).
  defaultShiftStart: process.env.SHIFT_START ?? "08:00",
  gracePeriodMinutes: Number(process.env.GRACE_PERIOD_MINUTES ?? 10),
  defaultStandardDailyHours: Number(process.env.STANDARD_DAILY_HOURS ?? 6),

  // Uniform eligibility thresholds (apply school-wide regardless of the
  // staff member's own group's standard daily hours).
  holidayAttendanceThresholdHours: Number(process.env.HOLIDAY_ATTENDANCE_THRESHOLD_HOURS ?? 3),
  overtimeEligibleThresholdHours: Number(process.env.OVERTIME_ELIGIBLE_THRESHOLD_HOURS ?? 8),

  // Overtime policy, mirroring the legacy portal's General Settings page.
  otMaxContinuousMinutes: Number(process.env.OT_MAX_CONTINUOUS_MINUTES ?? 480),
  otSubmissionWindowDays: Number(process.env.OT_SUBMISSION_WINDOW_DAYS ?? 3),
  // OT/payroll reporting period runs <this day> of a month through
  // <this day - 1> of the next, not the calendar month (e.g. 16th -> 15th).
  otPeriodStartDay: Number(process.env.OT_PERIOD_START_DAY ?? 16),
};

if (nodeEnv !== "production") {
  console.warn(`[env] NODE_ENV=${nodeEnv} — dev-only behavior (insecure cookies, DEV_BYPASS_AUTH) may be reachable. Never run this outside a trusted local machine.`);
}

/** DEV_BYPASS_AUTH must never be honored outside development, regardless of the env value. */
export function isDevBypassAuthActive(): boolean {
  return env.nodeEnv === "development" && env.devBypassAuth;
}
