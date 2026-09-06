# Project State
_Managed by PM Agent. Do not edit manually._

updated_at: 2026-09-06
project: HR Management Portal (Kinbidhoo School) — React/TS/Tailwind + Node/Express/TS + PostgreSQL/Prisma, npm workspaces (frontend/backend/shared)

---

## AGENTS

| Slot | Role | Status | Current Task | Files Locked |
|------|------|--------|--------------|--------------|
| 1 | Feature Agent | IDLE | — | — |
| 2 | Fix Agent | IDLE | — | — |
| 3 | Refactor Agent | IDLE | — | — |
| 4 | Deployment Agent | IDLE | — | — |

---

## TASKS

| ID | Title | Type | Status | Agent | Files | Started | Notes |
|----|-------|------|--------|-------|-------|---------|-------|

---

## BLOCKED

| Task ID | Reason | Blocked Since | Owner |
|---------|--------|---------------|-------|

---

## COMPLETED (last 10)

| Task ID | Title | Completed | Agent |
|---------|-------|-----------|-------|
| T-2026-09-06-018 | Scaffold: npm workspaces, Prisma schema, Google OAuth (domain-restricted) + JWT auth + RBAC, PM-agent setup | 2026-09-06 | 1 |
| T-2026-09-06-019 | Staff Details module (directory, self-service, docs/photo upload, status history) | 2026-09-06 | 1 |
| T-2026-09-06-020 | Time Clock & Attendance incl. ZKTime 5.0 import job | 2026-09-06 | 1 |
| T-2026-09-06-021 | Overtime module (requests, approval chain, rates, exports, dashboard) | 2026-09-06 | 1 |
| T-2026-09-06-022 | Leave Management (types, balances, approval chain, term calendar) | 2026-09-06 | 1 |
| T-2026-09-06-023 | Seed data, README, docs/DEPLOY.md | 2026-09-06 | 1 |

---

## SECURITY REVIEW HISTORY

Three `finsec-analyst` passes during this build, findings fixed as found:

1. **Scaffold/auth (T-018):** 2×P0 (fail-open `NODE_ENV`/empty `JWT_SECRET` default) +
   5×P1/P2 (upload path traversal, no session revocation, no auth audit log,
   missing OAuth state, no security headers/rate limiting) — all fixed.
2. **Staff module (T-019):** 1×P0 (plaintext national ID leaking into
   `AuditLog` via a reused serializer) + 1×P1 (HR could edit own bank
   details) + several P2/P3 (TOCTOU race in edit-request review, CSV formula
   injection, missing audit entries, blind/broken review of encrypted-field
   edit requests) — all fixed. `toStaffAuditSnapshot()` now used everywhere
   staff data crosses into `recordAudit()`.
3. **Attendance/Overtime/Leave (T-020–022):** 2×P1 (no self-review guard in
   the shared `approvalChain.ts` — HR/HOD could approve their own requests;
   ZKTime manual-upload and file-watcher shared one directory with a
   duplicate-import race) + several P2/P3 (leave-balance TOCTOU at approval,
   no import size cap, malformed imports failing silently, incomplete audit
   coverage, term-calendar block not re-checked at approval, unvalidated
   cross-staff `timeEntryId` reference, chokidar substring-match bug) — all
   fixed.

**Known accepted residual items** (documented in `docs/DEPLOY.md`, not yet
fixed): no CSRF token beyond `SameSite=Lax`+CORS (revisit before wider
rollout); `exceljs`'s transitive `uuid` dependency has an open moderate
advisory with no non-breaking fix (low exploitability — never called
directly with attacker-controlled input).

---

## DATABASE: LIVE (2026-09-06)

Dedicated Supabase Postgres project `kinbidhoo-hr-portal`
(ref `gntszhhuvrmlhcxylofh`, org `shaviyani-pro`, region `ap-southeast-1`) —
deliberately separate from shaviyani-pro-tracker's own project. Migrated,
seeded, and verified end-to-end via curl: real login, AES-256-GCM
encrypt/decrypt round-trip, RBAC boundaries (including "not even your own
bank details"), the self-review approval guard against its exact exploit
scenario, and the ZKTime import + unmatched-device resolve flow. Full
details and the two real bugs this caught (ZKTime matching only checked
`AttendanceDevice`, not `Staff.deviceUserId`; date-range queries treated
`to` as literal midnight) are in `docs/DEPLOY.md`'s session log. Connection
strings live in `backend/.env` (gitignored) — see `docs/DEPLOY.md`'s
credential inventory for where to find them again.

## FRONTEND: BROWSER-VERIFIED (2026-09-06)

Drove the actual React app in headless Chromium (Playwright) against the
live database — login (HR_ADMIN and STAFF), navigation across all four
modules, and role-based rendering (decrypted bank/national-ID fields for
HR, correctly hidden for STAFF; STAFF sees own profile only, not the
directory). Found and fixed two real bugs neither `tsc` nor the security
reviews could catch: `shared`'s CommonJS-only build crashed the entire
frontend under Vite's dev-mode ESM serving (now dual CJS/ESM build), and
dev-bypass login never redirected away from `/login` after succeeding. Also
tightened `authenticate()` to stop misreporting a transient DB error as a
401 "invalid session" instead of a visible 500. Full write-up, including an
investigated-but-confirmed-non-issue (StrictMode dev-only double-fetch
racing a fast automated logout), is in `docs/DEPLOY.md`'s session log.

## PDF EXPORT: DONE (2026-09-07)

Added `lib/pdf.ts` (pdfkit-based simple table generator) and wired
`format=pdf` into both `GET /api/attendance/timesheet` and
`GET /api/overtime/summary`, alongside the existing CSV option. Verified by
generating and visually inspecting real PDFs against live data — clean
table, correct totals row, correct decrypted/derived values. Frontend has
"Export PDF" links next to "Export CSV" on the Attendance and Overtime
pages.

## GOOGLE OAUTH: LIVE (2026-09-07)

Real OAuth client created in Google Cloud Console under the
`kinbidhooschool.edu.mv` Workspace org, credentials set in `backend/.env`
(`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, gitignored — see
`docs/DEPLOY.md`'s credential inventory). Verified end-to-end: a real
Google account (`lassan@kinbidhooschool.edu.mv`, linked to the KS-0001
HR_ADMIN staff record for this test) completed the full sign-in flow and
landed correctly authenticated. Confirms the server-side domain check,
JWT issuance, and staff-record lookup all work against a real (not
dev-bypass) login. Redirect URI registered: only the local dev callback so
far — add the production callback URL once hosting is chosen.

## OVERTIME PRE-APPROVAL REWRITE + STAFF GROUPS + REAL LEAVE TYPES: DONE (2026-09-07)

Reverse-engineered from real legacy v7.0 screenshots (not the original
spec) and treated as a definitive correction, not a suggestion:

- **Overtime is pre-approval**, not after-the-fact hours reporting: staff
  request a date + time-in/time-out slot *before* doing the work, it goes
  through the usual staff → HOD → HR chain, and once APPROVED the staff
  member explicitly marks it "Complete OT Work" — only APPROVED +
  workCompleted + non-cancelled requests count toward payroll/the monthly
  ledger. Cancel is allowed any time before completion. New policy knobs
  (all env-configurable, mirroring the legacy General Settings page): max
  480-minute continuous duration per slot, 3-day submission window, and a
  16th-to-15th OT/payroll period instead of a calendar month.
- **`StaffGroup` model** added (New Framework: 8h/06:45 sign-in; Old
  Framework: 6h/06:45 sign-in) — attendance timesheet late-arrival/overtime
  flagging now uses each staff member's assigned group's shift settings,
  falling back to the school-wide default if unassigned.
- **Two uniform eligibility thresholds** added to the timesheet regardless
  of staff group, per explicit instruction: holiday-attendance-eligible at
  ≥3h worked on a weekend/holiday, overtime-eligible at ≥8h worked.
- **`LeaveType.deductsBalance`** flag replaces a fragile name-based "is this
  literally called 'unpaid'?" string check; leave types renamed to match the
  legacy portal's real ones (Annual Leave, Sick Leave With MC, Sick Leave
  Without MC, Family Responsibility Leave, Unpaid Leave, Maternity/Paternity
  Leave).
- A new school-wide **OT ledger** (`GET /api/overtime/ledger`, HR/HOD) mirrors
  the legacy "View and Manage Monthly OT Sheets" screen — one row per
  completed OT slot, not per-staff totals.

Deliberately deferred/out of scope (see README's "Deferred / out of scope"
under the same heading): Basic Salary + Self/Group-Capped columns (no plain
numeric salary field exists to cap against), an "Attendance Eligible"
cross-check against actual ZKTime punches, a manual "Verified" QA flag, the
unclear "Non-Official" column, and a real holiday calendar (holiday is
currently approximated as Saturday/Sunday).

Verified against the live Supabase database: full submit → HOD-approve →
HR-approve → complete cycle, cancel, duration-cap rejection, submission-
window rejection, and the double-approval guard, all via curl; submit,
cancel, and the ledger/dashboard data additionally confirmed rendering
correctly in a real browser (Playwright) with no console errors. Backend
and frontend both typecheck clean (`tsc --noEmit` / `tsc -b`, exit 0).
Transactional demo data (`OvertimeRequest`/`LeaveRequest`/`TimeEntry`) was
cleared and `db:seed` re-run afterward to remove test pollution from this
verification pass.

## NOT YET BUILT / KNOWN GAPS

- **Hosting** — not chosen; `docs/DEPLOY.md` is explicit that this blocks any
  real deploy and spells out the persistent-process/ephemeral-disk
  constraints on the backend.
- **Legacy v7.0 data migration** — schema is designed to receive migrated
  data, but no actual ETL script exists; needs the real v7.0 export format
  from the school before it can be written.
- **Leave accrual** — `LeaveBalance` is a static number HR sets/adjusts
  (`accrualRule` is descriptive text only), not an automatic monthly-accrual
  engine. Revisit if automatic accrual becomes a real requirement.
- **Overtime ledger's deferred fields** — see above: Basic Salary/Self-Capped/
  Group-Capped columns, Attendance Eligible cross-check, Verified QA flag,
  Non-Official column, and a real holiday/non-working-days calendar.
