# Kinbidhoo School — HR Management Portal

A from-scratch HR portal replacing a legacy v7.0 system (Overtime, Attendance,
Leave). Four modules: **Staff Details**, **Time Clock & Attendance** (with a
ZKTime 5.0 import job), **Overtime**, and **Leave Management**.

## Tech stack

- **Frontend:** React + TypeScript + Vite + Tailwind CSS + React Router
- **Backend:** Node.js + Express 5 + TypeScript
- **Database:** PostgreSQL via Prisma (schema: `backend/prisma/schema.prisma`)
- **Auth:** Google OAuth 2.0, restricted to a single Google Workspace domain
- **Monorepo:** npm workspaces — `frontend/`, `backend/`, `shared/` (common TS
  types/enums used by both sides)

## Roles

- **Staff** — own profile, own attendance/overtime/leave, edit-requests for
  locked profile fields.
- **HOD** — department-scoped staff directory (limited fields), full
  visibility + first-stage approval on their department's overtime/attendance
  correction/leave requests.
- **HR/Admin** — full access, including bank/payroll fields (never visible to
  Staff or HOD), final-stage approvals, staff provisioning, rate/leave-type
  configuration, ZKTime import.

## Prerequisites

- Node.js 20+ and npm 10+
- A PostgreSQL instance — a [Supabase](https://supabase.com) project (what
  this app currently runs on — see `docs/DEPLOY.md`), Docker
  (`docker-compose.yml` at the repo root spins one up locally), or your own
  Postgres server
- A Google Cloud project for OAuth (see below) — optional for local dev if
  you use the `DEV_BYPASS_AUTH` escape hatch instead

## Setup

```bash
npm install                          # installs frontend/backend/shared workspaces

cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

Set `DATABASE_URL` (and `DIRECT_URL`) in `backend/.env` — either your
Supabase project's connection strings (Project Settings → Database; see the
IPv6 note in `.env.example` if migrations can't resolve the direct-connection
host) or, for a fully local setup, `docker compose up -d` and the
`docker-compose.yml` defaults already in `.env.example`.

Generate the two required secrets and put them in `backend/.env`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # -> JWT_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" # -> ENCRYPTION_KEY
```

`ENCRYPTION_KEY` is the AES-256-GCM key used to encrypt `national_id`, bank
account numbers, and salary grade at rest (`backend/src/lib/encryption.ts`).
Losing it makes that data permanently unreadable — back it up somewhere safe,
outside the repo.

Then run migrations and seed demo data:

```bash
cd backend
npx prisma migrate dev
npm run db:seed
```

Start both apps (from the repo root, in two terminals):

```bash
npm run dev:backend   # http://localhost:4000
npm run dev:frontend  # http://localhost:5173
```

## Google OAuth domain restriction

_Verified working end-to-end (2026-09-07) — real Google sign-in against the
`kinbidhooschool.edu.mv` Workspace domain, landing correctly on the linked
staff record. Steps below for reference / setting it up again elsewhere._

1. In [Google Cloud Console](https://console.cloud.google.com/), create an
   OAuth 2.0 Client ID (type: Web application) under your Workspace org's
   project.
2. Authorized redirect URI: `http://localhost:4000/api/auth/google/callback`
   (and your production callback URL once deployed).
3. Put the client ID/secret in `backend/.env`:
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   ALLOWED_GOOGLE_DOMAIN=kinbidhooschool.edu.mv
   ```
4. The domain check happens **server-side** on the OAuth callback
   (`backend/src/lib/auth.ts`'s `isAllowedDomain()`), verifying Google's `hd`
   claim / the account's email domain — not just a client-side hint. A Google
   account outside `ALLOWED_GOOGLE_DOMAIN`, or one without a matching
   provisioned `Staff` record, is rejected; there is no self-registration —
   HR/Admin must create the staff record first (`POST /api/staff`).

### Local dev without real Google credentials

Set `DEV_BYPASS_AUTH=true` (already the default in `.env.example`) and
`NODE_ENV=development`. The login page then shows a "Dev sign in" box where
you can log in as any seeded staff ID (`KS-0001` through `KS-0007` — see
`backend/prisma/seed.ts`) without a real OAuth flow. This is hard-gated in
code (`backend/src/lib/env.ts`'s `isDevBypassAuthActive()`) to never work
outside `NODE_ENV=development`, regardless of the flag's value.

## Running the ZKTime 5.0 import job

Two ways to feed a ZKTime export into the portal — both call the same parser
(`backend/src/jobs/zktimeImport.ts`), so behavior is identical either way:

1. **Watched folder** — drop a `.csv`/`.xlsx`/`.xls` export into
   `backend/import-watch/incoming/`. A file-watcher
   (`backend/src/jobs/zktimeWatcher.ts`, started automatically with the
   backend) picks it up within ~1 second and moves it to `incoming/processed/`
   once imported.
2. **Manual upload** — in the app, go to **Attendance → Attendance Import**
   (HR/Admin only) and upload the file directly.

A sample export is included at
`backend/prisma/seed-data/zktime-sample-export.csv` — device IDs `1001` and
`1002` match seeded staff (`KS-0004`, `KS-0005`); device `9999` is
deliberately unmatched so you can try the **admin review queue** (link an
unmatched device ID to a staff record — this also backfills that staff's
`device_user_id` for all future imports).

Every import run — watched or manual — is logged to `attendance_sync_log`
(file name, processed/matched/unmatched counts, timestamp), visible in the
same Attendance Import screen.

The parser matches header names case-insensitively against several common
ZKTime column names (`User ID`/`AC-No`/`Enroll Number`/`PIN`/... for the
device ID; `Time`/`Date/Time`/`Timestamp`/... for the punch time; `Status`/
`Punch Type`/... for IN/OUT — falling back to strict alternation per
device-per-day if no status column is present). If your ZKTime export uses
different headers, add them to the candidate lists in `zktimeImport.ts`.

## Project structure

```
frontend/     Vite React TS app (pages per module under src/pages/)
backend/
  src/
    modules/{staff,attendance,overtime,leave}/   routes, service, validation
    lib/          auth, RBAC, encryption, audit, error handling, uploads
    jobs/         ZKTime import + file watcher
  prisma/         schema.prisma, seed.ts, seed-data/
shared/         TS enums/types shared by frontend and backend
docs/DEPLOY.md  release-engineer runbook (hosting not yet chosen — see there)
.claude/        PM-agent task ledger + specialist subagent definitions
```

## Security notes

- Bank account number, salary grade, and national ID are encrypted at rest
  (AES-256-GCM) and are never included in any audit-log entry, HOD-facing
  response, or CSV export — see `backend/src/lib/encryption.ts` and each
  module's `serializers.ts`.
- Every approval/rejection and every payroll/PII-touching write is recorded
  in `audit_log` (`backend/src/lib/audit.ts`).
- Sessions are revoked immediately (not just at JWT expiry) on logout, status
  change, or role/department change — see `sessionVersion` in
  `backend/src/lib/auth.ts`.
- Known follow-up: state-changing endpoints rely on `SameSite=Lax` cookies +
  strict single-origin CORS for CSRF protection rather than an explicit CSRF
  token. Consider adding token-based defense-in-depth before a wider rollout.
- This codebase has been through three `finsec-analyst` review passes during
  development (scaffold/auth, Staff module, Attendance+Overtime+Leave) with
  findings fixed as they were found — see `.claude/project-state.md`'s
  COMPLETED task notes for what each pass covered. Re-run a review after any
  further change to auth, RBAC, or the encrypted fields.

## Known limitations

- **Hosting hasn't been chosen** — see `docs/DEPLOY.md` before deploying;
  the backend needs a host that runs a persistent Node process (it isn't a
  drop-in fit for plain serverless functions).
- **No legacy v7.0 data migration script** — the schema is designed to
  receive migrated staff/overtime/leave history, but no ETL exists; it needs
  the actual v7.0 export format.
- Migrations, seeding, core API flows, and the actual React frontend (driven
  in a real browser via Playwright) have all been run end-to-end against a
  real Supabase Postgres database, as HR_ADMIN, HOD, and STAFF users — login,
  navigation, decrypted-field rendering, role restrictions, and both the
  two-stage HOD→HR overtime approval chain and the HR-fast-track leave
  approval (including the resulting leave-balance deduction) were driven by
  actual button clicks, not just API calls. See `docs/DEPLOY.md`'s session
  logs for the five real bugs this process caught (all fixed).
