# Project State
_Managed by PM Agent. Do not edit manually._

updated_at: 2026-09-06
project: HR Management Portal (Kinbidhoo School) — React/TS/Tailwind + Node/Express/TS + PostgreSQL/Prisma, npm workspaces (frontend/backend/shared)

---

## AGENTS

| Slot | Role | Status | Current Task | Files Locked |
|------|------|--------|--------------|--------------|
| 1 | Feature Agent | BUSY | T-2026-09-06-021, T-2026-09-06-022 | frontend/, backend/, shared/, package.json |
| 2 | Fix Agent | IDLE | — | — |
| 3 | Refactor Agent | IDLE | — | — |
| 4 | Deployment Agent | IDLE | — | — |

---

## TASKS

| ID | Title | Type | Status | Agent | Files | Started | Notes |
|----|-------|------|--------|-------|-------|---------|-------|
| T-2026-09-06-020 | Time Clock & Attendance incl. ZKTime 5.0 import job | FEATURE | REVIEW-PENDING | 1 | backend/src/modules/attendance/, frontend/src/pages/attendance/ | 2026-09-06 | Backend (manual clock, ZKTime watcher+upload import job, unmatched review queue, sync log, timesheet w/ flags, dept dashboard, correction workflow, CSV export) + frontend built, typechecked. Parser sanity-tested standalone (no DB in this env for full E2E). Consolidated finsec-analyst pass launched covering this + 021 + 022 (approval-chain modules). |
| T-2026-09-06-021 | Overtime module (requests, approval chain, rates, exports, dashboard) | FEATURE | REVIEW-PENDING | 1 | backend/src/modules/overtime/, frontend/src/pages/overtime/ | 2026-09-06 | Backend (submit/approve chain via shared approvalChain lib, per-department weekday/weekend/holiday rates with effective-dated history, monthly summary+CSV export, dept dashboard) + frontend built, typechecked. |
| T-2026-09-06-022 | Leave Management (types, balances, approval chain, term calendar) | FEATURE | REVIEW-PENDING | 1 | backend/src/modules/leave/, frontend/src/pages/leave/ | 2026-09-06 | Backend (leave types, term-calendar block enforcement, balance-checked submission + deduction on approval, approval chain, history, dept calendar) + frontend built, typechecked. |
| T-2026-09-06-023 | Seed data, README, docs/DEPLOY.md skeleton | REVIEW | DONE-PENDING-CONFIRM | 1 | backend/prisma/seed.ts, README.md, docs/DEPLOY.md | 2026-09-06 | Seed script (depts, leave types, term calendar, overtime rates, 7 staff across roles/depts incl. device IDs matching the sample ZKTime CSV, bank details, balances, sample overtime/leave/time entries) typechecks + runs up to the DB call. README covers setup, OAuth domain config, dev-bypass, ZKTime import (both paths), security notes, and known limitations (no PDF export yet, hosting TBD, no live DB in this dev env). docs/DEPLOY.md filled in per release-engineer's expected format, hosting explicitly marked BLOCKED with the persistent-backend/ephemeral-disk caveats spelled out. |

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
