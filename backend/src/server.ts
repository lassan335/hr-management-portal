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
app.use(
  cors({
    origin: env.frontendOrigin,
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

app.use((_req, res) => res.status(404).json({ error: "not_found" }));
app.use(errorHandler);

app.listen(env.port, () => {
  console.log(`HR portal API listening on :${env.port} (${env.nodeEnv})`);
  if (env.nodeEnv === "development" && env.devBypassAuth) {
    console.log("DEV_BYPASS_AUTH is active — POST /api/auth/dev-login with { staffId }.");
  }
});

startZktimeWatcher();
