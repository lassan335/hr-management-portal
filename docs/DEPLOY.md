# Deployment Runbook — HR Management Portal (Kinbidhoo School)

_Source of truth for the release-engineer agent (`.claude/agents/release-engineer.md`)
and for humans doing a manual deploy. Read this file first; it overrides that
agent's prompt if they ever conflict. Update this file (and commit it) at the
end of every deploy-related run — durable infra facts belong here, not in
agent memory or prose._

## Status: database provisioned, app hosting not yet chosen

Local git only, no remote, no CI, no app hosting yet — but the database is
real: a dedicated Supabase Postgres project (`kinbidhoo-hr-portal`, separate
from the shaviyani-pro-tracker project's own Supabase project — deliberate,
given this app holds national ID / bank data). Migrated, seeded, and smoke
tested end to end (real login, encrypted-field round-trip, ZKTime import,
RBAC boundaries — see Session log below). The **app hosting** section further
down is still a template to fill in.

## The deployment topology

- **App shape:** npm workspaces monorepo — `frontend/` (static Vite build),
  `backend/` (persistent Node/Express process, NOT serverless-function
  shaped as written — it holds a long-lived `chokidar` file watcher and a
  Prisma connection pool). Plan hosting accordingly: the backend needs a host
  that runs a long-lived process (e.g. Render, Railway, Fly.io, a school-owned
  VM/server), not a bare Vercel serverless-functions deploy.
- **Database:** PostgreSQL via Prisma, hosted on Supabase (project
  `kinbidhoo-hr-portal`, org `shaviyani-pro`, region `ap-southeast-1`). Two
  connection strings, per Supabase's pooler (Supavisor) setup:
  `DATABASE_URL` (transaction-mode pooler, port 6543, `?pgbouncer=true`) is
  what the running app uses; `DIRECT_URL` is a session-mode connection Prisma
  needs for `migrate`/`db push` (a transaction-mode pooler doesn't support
  the session state migrations require). **Important:** Supabase's literal
  "direct connection" host (`db.<ref>.supabase.co:5432`) is IPv6-only —
  it was unreachable from this build environment (no IPv6 egress) with a DNS
  `ENOTFOUND`. Worked around by pointing `DIRECT_URL` at the **pooler
  hostname in session mode instead** (`aws-0-<region>.pooler.supabase.com:5432`,
  no `?pgbouncer=true`) — same pooler host as `DATABASE_URL`, different port,
  and it's IPv4-reachable. If your deploy host *does* have IPv6, the literal
  direct-connection host works too and is marginally preferred for
  migrations; the pooler session-mode fallback is a fully supported
  alternative either way, not a hack specific to this one environment.
  `docker-compose.yml` at the repo root is local-dev-only and unrelated to
  this Supabase project.
- **Migrations:** run explicitly via `npx prisma migrate deploy` (from
  `backend/`) against `DATABASE_URL`, deliberately separate from the build
  step so production DB credentials never enter a build environment.
- **File storage:** uploaded documents/photos live on the backend's local
  disk (`backend/uploads/`) and the ZKTime import watcher reads from
  `backend/import-watch/incoming/`. On any host that doesn't guarantee a
  persistent, single-instance filesystem (most PaaS "ephemeral" containers,
  or any horizontally-scaled/multi-instance deploy), **this breaks** —
  uploaded files would vanish on redeploy/restart, and the file watcher would
  only see files that land on the same instance. Before scaling past a single
  instance or choosing an ephemeral-disk host, migrate `uploads/` to object
  storage (S3-compatible) and reconsider the watcher (a manual-upload-only
  flow, or a queue-based import trigger, would remove the local-disk
  dependency entirely).
- **Encryption key:** `ENCRYPTION_KEY` (AES-256-GCM) protects national ID,
  bank account number, and salary grade at rest. It is checked at process
  boot (`assertEncryptionConfigured()` in `server.ts`) — a missing/malformed
  key fails the deploy immediately rather than failing on first PII read.
  **There is no key-rotation tooling yet** — rotating it requires
  decrypting every encrypted column with the old key and re-encrypting with
  the new one before the old key is discarded. Plan for this before any
  compliance-driven rotation requirement.

## Deployment coordinates — BLOCKED (hosting not yet chosen)

- **Prod URL:** *(none yet)*
- **Hosting platform / project identifiers:** *(decide: backend host running
  a persistent Node process; frontend can be static hosting/CDN or the same
  host)*
- **Database:** Supabase project `kinbidhoo-hr-portal` (ref
  `gntszhhuvrmlhcxylofh`), org `shaviyani-pro`, region `ap-southeast-1`. This
  part is done — see the topology note above for the pooler/direct-URL setup.
- **Git remote:** *(none yet — local git only)*

Fill these in — with real values read from the repo's config files and the
secrets store at deploy time, never hardcoded here — once a hosting decision
is made. Until then, `/pm deploy` should treat any deploy request as blocked
on this decision (see `.claude/deploy-queue.md`).

## Credential & key inventory (names/locations only — NEVER values)

| Variable | Purpose | Where it lives (fill in once deployed) |
|---|---|---|
| `DATABASE_URL` | Postgres connection string (pooled) | `backend/.env` (local); Supabase dashboard → Project Settings → Database (source of truth) |
| `DIRECT_URL` | Postgres connection string (session-mode, for migrations) | `backend/.env` (local); same Supabase page |
| `JWT_SECRET` | Session JWT signing key (HS256, ≥32 chars) | *(TBD)* |
| `ENCRYPTION_KEY` | AES-256-GCM key for national ID / bank / salary fields | *(TBD — treat as a crown jewel; back up separately from the app's own secrets store)* |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth app credentials | *(TBD — Google Cloud Console project)* |
| `ALLOWED_GOOGLE_DOMAIN` | Workspace domain restriction (not secret, but must match prod) | *(TBD)* |
| `SMTP_*` | Optional email notifications | *(TBD, if used)* |
| `DEV_BYPASS_AUTH` | **Must be unset/false in every non-development environment** | N/A — verify absent from prod env, not just "set to false" |

On every deploy-related run: read this table, reconcile it against
`.env*` files, the host's env settings, and any CI secrets, then update this
table with any change (new var, rotated location) and commit it. Never write
an actual secret value here or anywhere in the repo.

## Preflight checklist (before any real deploy)

1. Hosting + managed Postgres chosen and provisioned.
2. All variables in the credential inventory above set in the host's env.
3. `DEV_BYPASS_AUTH` confirmed **absent or false** in the prod environment
   (the app fails closed on `NODE_ENV`, but this is still worth an explicit
   check).
4. `npx prisma migrate deploy` run against the prod `DATABASE_URL` (see
   topology note above — never `prisma migrate dev` in prod, and never reset
   a prod database).
5. Google OAuth redirect URI updated to the prod callback URL.
6. `uploads/` and `import-watch/` persistence story decided (see topology
   note) if deploying to more than one instance or an ephemeral-disk host.
7. A real STANDING MANDATE for this host's readiness-check API and a real
   smoke-test script under `.claude/smoke/` — write these once the host is
   chosen, mirroring the shape of a typical "trigger → poll for ready →
   confirm deployed commit SHA → mark DEPLOYED" flow before relying on the
   release-engineer agent for autonomous deploys.

## Session log: first live-database verification (2026-09-06)

Once a real Supabase database existed, `npx prisma migrate dev` and
`npm run db:seed` ran successfully, and the following were exercised against
real data for the first time (previously only typechecked/boot-tested):

- Real login (dev-bypass) + JWT session issuance, `/api/auth/me`
- AES-256-GCM encryption round-trip: national ID and bank account
  number/salary grade correctly decrypt back to their original values
- RBAC boundaries: STAFF blocked from the full directory (403) and from
  bank details **even on their own record** (matches spec — HR/Admin-only,
  no self exception)
- The self-review guard fix (`cannot_review_own_request`) — reproduced the
  exact P1 exploit scenario from the finsec review (HR_ADMIN submitting then
  approving their own overtime request) and confirmed it's now blocked
- ZKTime import against the real sample export, including the unmatched
  device review/resolve flow

Two real bugs surfaced by this (neither caught by typecheck/boot-test/code
review, since both are runtime data-matching issues, not type errors):

1. **ZKTime import matching only checked `AttendanceDevice.staffId`**, never
   `Staff.deviceUserId` directly — a staff record provisioned/seeded with a
   `deviceUserId` but no corresponding `AttendanceDevice` row would never
   match on import. Fixed in `jobs/zktimeImport.ts`: matching now looks up
   `Staff` by `deviceUserId` directly (the source of truth), and
   `AttendanceDevice` is upserted alongside as a registry/audit table rather
   than being the match source itself.
2. **Date-range queries treated a `to` date param as literal midnight**,
   silently excluding same-day entries with a time component later than
   00:00 UTC (attendance timesheet and department dashboard). Fixed via a
   new `lib/dateRange.ts::endOfUtcDay()` helper applied to both. (Overtime's
   month-range building and the leave calendar's date-only comparisons were
   checked and don't have this bug — both already compare same-granularity
   values.)

Also backdated the seeded `OvertimeRate.effectiveFrom` to the start of the
year — the default ("now", i.e. seed-run time) was later than the sample
overtime requests' dates, so the demo showed a null rate/cost for "no rate
in effect yet" even though that's correct app behavior for the seed
timing, not a bug.

## Session log: first real-browser verification (2026-09-06)

Everything above this point was verified via `curl` against the API
directly. This pass drove the actual React frontend in headless Chromium
(Playwright) against the live Supabase database for the first time — login,
navigation, and data rendering across all four modules, as both an
HR_ADMIN and a STAFF user.

Two more real bugs surfaced, both in frontend code neither the backend
security reviews nor `tsc` could have caught:

1. **The whole app failed to load** — `shared`'s build was CommonJS-only
   (`tsc` with `module: CommonJS`), but Vite serves an npm-workspace-linked
   package as raw ES module source in dev rather than pre-bundling it, and
   a CJS file's `exports.X = ...` assignments aren't visible as named ESM
   exports to a raw `import { Role } from "@hr/shared"`. Every page crashed
   with `does not provide an export named 'Role'` before rendering anything.
   Fixed with a dual CJS/ESM build (`shared/tsconfig.esm.json` +
   `package.json`'s `exports` map: `require` → CJS for the Node/tsx backend,
   `import` → ESM for Vite/the frontend).
2. **Dev-bypass login never navigated anywhere** — `Login.tsx`'s dev-login
   handler called the API and refreshed auth state, but nothing redirected
   away from `/login` afterward (the Google OAuth path is unaffected since
   the backend does a full-page redirect on that path). A user would
   successfully authenticate and then keep staring at the login form. Fixed
   by redirecting to `/` whenever `AuthContext`'s `user` becomes truthy
   while on the login page.

Also tightened `lib/auth.ts`'s `authenticate()` middleware: it previously
wrapped the JWT verification AND the subsequent DB session-check in one
try/catch, so a transient database error during the DB check was
misreported as `401 invalid_session` (looks like "your session expired")
instead of surfacing as a real `500` (visible in logs, distinguishable from
an actual auth problem). JWT verification failure is still a clean 401; a
DB error during the session check now propagates to `errorHandler` instead.

**Investigated but NOT a bug:** intermittent `401 invalid_session` responses
were observed on `/api/leave`, `/api/overtime`, etc. during rapid automated
clicking, traced via added-then-removed debug logging to React 19
StrictMode's dev-only double-invocation of data-fetching `useEffect`s (no
`AbortController` cleanup on any of them). Under real network latency to
Supabase (~250–800ms/query from this environment), the second, redundant
invocation's fetch can still be in flight when a fast script (not a real
human) immediately clicks "Sign out" afterward, so it lands with an
already-invalidated cookie — a duplicate, harmless request racing a session
teardown that a real user's pace would never trigger. Confirmed via direct
`curl` calls that the underlying data and endpoints are correct throughout
(e.g. the overtime dashboard/list this had made look "empty" in a
screenshot returned full, correct data seconds later via `curl`). This
double-invocation is dev-only — production React does not do it — so it
does not reproduce in a production build. Left as a minor follow-up: adding
`AbortController` cleanup to data-fetching effects would eliminate the
console noise, but has no functional impact on any real user.

Screenshots from this pass (HR dashboard, staff directory, staff detail
with decrypted bank/national-ID fields, attendance dashboard, a STAFF
user's own restricted profile view) were sent to the user directly rather
than committed to the repo.

## Session log: approval-chain click-through + PDF export (2026-09-07)

Closed the one remaining unclicked path from the prior session: drove the
actual Approve buttons in the browser (not just API calls) through both
approval patterns —

- **Two-stage chain:** logged in as the Mathematics HOD (KS-0002), clicked
  Approve on Ahmed Rasheed's overtime request (moves `PENDING_HOD` →
  `PENDING_HR`), then logged in as HR_ADMIN and clicked Approve again for
  the final sign-off. Confirmed in the database afterward: `hodReviewerId`
  and `hrReviewerId` are two different people with sequential timestamps,
  status `APPROVED`.
- **HR fast-track:** the Languages department has no HOD in the seed data,
  so HR_ADMIN approving Hussain Waheed's sick-leave request at the
  `PENDING_HOD` stage should jump straight to `APPROVED` per
  `approvalChain.ts`'s fast-track rule. Confirmed both `hodReviewerId` and
  `hrReviewerId` are recorded as the same HR_ADMIN, and — the part that
  actually matters — his Sick leave balance was correctly decremented
  12 → 10 days (2 inclusive days, Sep 9–10).

No new bugs found; this exercised code paths already covered by the T-020–
022 finsec-analyst review and the earlier API-level approval-chain checks,
just via real clicks instead of `curl`/`fetch`. (Screenshots taken during
this pass again showed the pending list rendering "None." at the moment of
capture before the click succeeded — the same benign StrictMode
double-fetch timing artifact already documented above; the clicks
themselves worked immediately, confirmed both by Playwright's auto-waiting
succeeding and by the database state after.)

Also added PDF export (`lib/pdf.ts`, pdfkit) for the two exports the spec
calls out as PDF/CSV: `GET /api/attendance/timesheet?format=pdf` and
`GET /api/overtime/summary?format=pdf`, with matching "Export PDF" links
in the UI. Verified by generating real PDFs against live data and visually
inspecting them (correct table, correct totals row).

## Known residual findings from security review (not yet remediated)

Tracked here so they aren't lost before a first real deploy — see
`.claude/agents/finsec-analyst.md`'s review history for full detail:

- No CSRF token (relies on `SameSite=Lax` + strict CORS) — acceptable for
  now, revisit before wider rollout.
- `uuid`-via-`exceljs` transitive dependency has an open moderate advisory
  (buffer-bounds-check in `uuid` <11.1.1) with no non-breaking fix available;
  low exploitability here since the app never calls `uuid` directly or passes
  attacker-controlled buffers into it. Re-check `npm audit` periodically.
