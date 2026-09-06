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

## NOT YET BUILT / KNOWN GAPS

- **PDF export** — CSV only for timesheets/overtime summaries so far.
- **Live DB verification** — this dev environment had no Docker/Postgres, so
  `prisma migrate dev` + `npm run db:seed` + the full OAuth/dev-bypass/ZKTime
  flow need to be run end-to-end on a machine with Postgres before relying on
  this. Schema validated, boot-tested, and the ZKTime parser was sanity-tested
  standalone against a sample file — but no live query has ever run.
- **Hosting** — not chosen; `docs/DEPLOY.md` is explicit that this blocks any
  real deploy and spells out the persistent-process/ephemeral-disk
  constraints on the backend.
- **Legacy v7.0 data migration** — schema is designed to receive migrated
  data, but no actual ETL script exists; needs the real v7.0 export format
  from the school before it can be written.
- **Leave accrual** — `LeaveBalance` is a static number HR sets/adjusts
  (`accrualRule` is descriptive text only), not an automatic monthly-accrual
  engine. Revisit if automatic accrual becomes a real requirement.
