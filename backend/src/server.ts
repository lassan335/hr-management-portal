import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import passport from "passport";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { env } from "./lib/env";
import { assertEncryptionConfigured } from "./lib/encryption";
import { configurePassport, authRouter } from "./lib/auth";
import { filesRouter } from "./lib/upload";
import { errorHandler } from "./lib/errors";
import { staffRouter } from "./modules/staff/routes";
import { attendanceRouter } from "./modules/attendance/routes";
import { overtimeRouter } from "./modules/overtime/routes";
import { leaveRouter } from "./modules/leave/routes";
import { payrollRouter } from "./modules/payroll/routes";
import { holidaysRouter } from "./modules/holidays/routes";
import { startZktimeWatcher } from "./jobs/zktimeWatcher";

// Fail fast on a misconfigured/missing ENCRYPTION_KEY at boot, not on the
// first PII read/write in production.
assertEncryptionConfigured();

configurePassport();

const app = express();
app.use(
  helmet({
    contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], frameAncestors: ["'none'"] } },
    hsts: { maxAge: 15552000, includeSubDomains: true },
  })
);
// In development, also allow the same frontend reached over the local
// network (e.g. from a phone on the same Wi-Fi) — production still only
// ever allows the single configured FRONTEND_ORIGIN.
const devLanOrigin = /^http:\/\/192\.168\.\d{1,3}\.\d{1,3}:5173$/;
app.use(
  cors({
    origin:
      env.nodeEnv === "development"
        ? (origin, cb) => {
            if (!origin || origin === env.frontendOrigin || devLanOrigin.test(origin)) return cb(null, true);
            cb(new Error("not allowed by CORS"));
          }
        : env.frontendOrigin,
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());
app.use(passport.initialize());

app.get("/api/health", (_req, res) => res.json({ ok: true, env: env.nodeEnv }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
app.use("/api/auth", authLimiter, authRouter());
app.use("/api/files", filesRouter());
app.use("/api/staff", staffRouter());
app.use("/api/attendance", attendanceRouter());
app.use("/api/overtime", overtimeRouter());
app.use("/api/leave", leaveRouter());
app.use("/api/payroll", payrollRouter());
app.use("/api/holidays", holidaysRouter());

app.use((_req, res) => res.status(404).json({ error: "not_found" }));
app.use(errorHandler);

app.listen(env.port, () => {
  console.log(`HR portal API listening on :${env.port} (${env.nodeEnv})`);
  if (env.nodeEnv === "development" && env.devBypassAuth) {
    console.log("DEV_BYPASS_AUTH is active — POST /api/auth/dev-login with { staffId }.");
  }
});

startZktimeWatcher();
