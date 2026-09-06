import crypto from "crypto";
import { Request, Response, NextFunction, Router } from "express";
import jwt from "jsonwebtoken";
import passport from "passport";
import { Strategy as GoogleStrategy, Profile } from "passport-google-oauth20";
import { AuthUser, Role } from "@hr/shared";
import { env, isDevBypassAuthActive } from "./env";
import { prisma } from "./prisma";
import { recordAudit, requestMeta } from "./audit";

const SESSION_COOKIE = "hr_session";
const OAUTH_STATE_COOKIE = "oauth_state";
const JWT_ALGORITHM = "HS256";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    // Passport's own types declare `Request.user?: User` — extend `User`
    // itself (declaration merging) instead of redeclaring `Request.user`,
    // which would conflict with passport's declaration.
    // eslint-disable-next-line @typescript-eslint/no-empty-interface
    interface User extends AuthUser {}
  }
}

function toAuthUser(staff: {
  id: string;
  staffId: string;
  role: string;
  departmentId: string | null;
  fullName: string;
  googleEmail: string;
  sessionVersion: number;
}): AuthUser {
  return {
    staffId: staff.id,
    role: staff.role as Role,
    departmentId: staff.departmentId,
    fullName: staff.fullName,
    googleEmail: staff.googleEmail,
    sessionVersion: staff.sessionVersion,
  };
}

function issueSessionCookie(res: Response, user: AuthUser) {
  const token = jwt.sign(user, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn as any,
    algorithm: JWT_ALGORITHM,
  });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 12,
  });
}

/** Invalidates every outstanding session JWT for a staff member immediately —
 * call on logout, status change, and role/department change. */
export async function bumpSessionVersion(staffId: string) {
  await prisma.staff.update({
    where: { id: staffId },
    data: { sessionVersion: { increment: 1 } },
  });
}

/**
 * Verifies the Google profile's hosted-domain / verified email domain matches
 * ALLOWED_GOOGLE_DOMAIN server-side. This is the actual security boundary —
 * the `hd` param passed to the authorize URL is only a UI hint and must never
 * be trusted on its own.
 */
function isAllowedDomain(profile: Profile): boolean {
  const hd = (profile._json as { hd?: string }).hd;
  if (hd) return hd.toLowerCase() === env.allowedGoogleDomain.toLowerCase();

  const email = profile.emails?.[0]?.value ?? "";
  const domain = email.split("@")[1]?.toLowerCase();
  return domain === env.allowedGoogleDomain.toLowerCase();
}

export function configurePassport() {
  if (!env.googleClientId || !env.googleClientSecret) {
    // Allowed in dev when DEV_BYPASS_AUTH covers local testing; real deploys
    // must set these or /api/auth/google will fail at request time.
    return;
  }

  passport.use(
    new GoogleStrategy(
      {
        clientID: env.googleClientId,
        clientSecret: env.googleClientSecret,
        callbackURL: env.googleCallbackUrl,
        passReqToCallback: true,
      },
      async (req: Request, _accessToken, _refreshToken, profile, done) => {
        try {
          if (!isAllowedDomain(profile)) {
            await recordAudit({
              actorId: null,
              action: "LOGIN_DOMAIN_REJECTED",
              entity: "Staff",
              entityId: profile.emails?.[0]?.value ?? "unknown",
              ...requestMeta(req),
            });
            return done(null, false, { message: "domain_not_allowed" });
          }
          const email = profile.emails?.[0]?.value;
          if (!email) return done(null, false, { message: "no_email" });

          const staff = await prisma.staff.findUnique({ where: { googleEmail: email } });
          if (!staff) {
            // No self-registration — HR/Admin must provision the staff record first.
            await recordAudit({
              actorId: null,
              action: "LOGIN_NO_STAFF_RECORD",
              entity: "Staff",
              entityId: email,
              ...requestMeta(req),
            });
            return done(null, false, { message: "no_staff_record" });
          }
          // Prisma's generated Role enum is structurally identical to but
          // nominally distinct from @hr/shared's Role — the callback route
          // handler below reconstructs a proper AuthUser via toAuthUser().
          return done(null, staff as unknown as Express.User);
        } catch (err) {
          return done(err as Error);
        }
      }
    )
  );
}

export function authRouter(): Router {
  const router = Router();

  router.get("/google", (req, res, next) => {
    // Stateless CSRF/login-CSRF protection: bind this authorize request to a
    // random value only this browser holds, verified on the callback below.
    // (No server session exists to lean on passport's built-in `state` support.)
    const state = crypto.randomBytes(16).toString("hex");
    res.cookie(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: env.isProduction,
      sameSite: "lax",
      maxAge: 5 * 60 * 1000,
    });
    passport.authenticate("google", {
      scope: ["profile", "email"],
      session: false,
      state,
      // Hint only — Google may not enforce it; isAllowedDomain() on callback
      // is the real, server-side check.
      hd: env.allowedGoogleDomain || undefined,
    } as any)(req, res, next);
  });

  router.get(
    "/google/callback",
    (req, res, next) => {
      const cookieState = req.cookies?.[OAUTH_STATE_COOKIE];
      res.clearCookie(OAUTH_STATE_COOKIE);
      if (!req.query.state || !cookieState || req.query.state !== cookieState) {
        return res.redirect(`${env.frontendOrigin}/login?error=invalid_state`);
      }
      next();
    },
    passport.authenticate("google", { session: false, failureRedirect: `${env.frontendOrigin}/login?error=access_denied` }),
    async (req, res) => {
      const staff = req.user as unknown as {
        id: string;
        staffId: string;
        role: string;
        departmentId: string;
        fullName: string;
        googleEmail: string;
        sessionVersion: number;
      };
      const authUser = toAuthUser(staff);
      issueSessionCookie(res, authUser);
      await recordAudit({
        actorId: authUser.staffId,
        action: "LOGIN_SUCCESS",
        entity: "Staff",
        entityId: authUser.staffId,
        after: { method: "google" },
        ...requestMeta(req),
      });
      res.redirect(env.frontendOrigin);
    }
  );

  // Local-only escape hatch — see isDevBypassAuthActive(). Never reachable
  // when NODE_ENV !== 'development', regardless of the DEV_BYPASS_AUTH value.
  router.post("/dev-login", async (req, res) => {
    if (!isDevBypassAuthActive()) {
      return res.status(404).json({ error: "not_found" });
    }
    const { staffId } = req.body as { staffId?: string };
    if (!staffId) return res.status(400).json({ error: "staffId required" });

    const staff = await prisma.staff.findUnique({ where: { staffId } });
    if (!staff) return res.status(404).json({ error: "staff not found" });

    const authUser = toAuthUser(staff);
    issueSessionCookie(res, authUser);
    await recordAudit({
      actorId: authUser.staffId,
      action: "LOGIN_DEV_BYPASS",
      entity: "Staff",
      entityId: authUser.staffId,
      ...requestMeta(req),
    });
    res.json({ ok: true });
  });

  router.post("/logout", async (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE];
    res.clearCookie(SESSION_COOKIE);
    if (token) {
      try {
        const payload = jwt.verify(token, env.jwtSecret, { algorithms: [JWT_ALGORITHM] }) as AuthUser;
        await bumpSessionVersion(payload.staffId);
        await recordAudit({
          actorId: payload.staffId,
          action: "LOGOUT",
          entity: "Staff",
          entityId: payload.staffId,
          ...requestMeta(req),
        });
      } catch {
        // Already invalid/expired — nothing to revoke, logout still succeeds.
      }
    }
    res.json({ ok: true });
  });

  router.get("/me", authenticate, (req, res) => {
    res.json(req.user);
  });

  return router;
}

export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return res.status(401).json({ error: "unauthenticated" });

  try {
    const payload = jwt.verify(token, env.jwtSecret, { algorithms: [JWT_ALGORITHM] }) as AuthUser;

    // Re-check current status/session-version on every request — a pure JWT
    // check alone would keep a terminated/suspended staff member's old token
    // valid for up to JWT_EXPIRES_IN after they're revoked.
    const staff = await prisma.staff.findUnique({
      where: { id: payload.staffId },
      select: { status: true, sessionVersion: true },
    });
    if (!staff || staff.status !== "ACTIVE" || staff.sessionVersion !== payload.sessionVersion) {
      return res.status(401).json({ error: "invalid_session" });
    }

    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: "invalid_session" });
  }
}
