# Deployment Queue
_Managed by PM Agent. Deployment Agent reads this file for instructions._

updated_at: 2026-09-06

---

## ⚠️ Hosting not yet chosen — deploy pipeline is BLOCKED

This is a fresh project with no git remote, no hosting provider, and no production
database yet. The backend is a persistent Node/Express process, so it needs a host
that runs a long-lived process (e.g. Render/Railway/Fly/a school-owned server) plus a
managed PostgreSQL instance — a plain Vercel-functions deploy is not a drop-in fit for
it, so the previous template's Vercel-MCP standing mandates have been removed rather
than filled in with placeholder values that don't apply.

**Before the first real deploy:**
1. Choose a hosting provider for the backend (persistent Node process) and one for the
   frontend (can be static hosting/CDN, or the same host).
2. Choose a managed PostgreSQL provider.
3. Fill in `docs/DEPLOY.md`'s Deployment coordinates + Credential inventory tables.
4. Write a real STANDING MANDATE here for that host's readiness-check API (mirroring
   the shape of the old Vercel-MCP mandate: trigger → poll for ready → confirm the
   deployed commit SHA → only then mark DEPLOYED) and a real smoke-test script under
   `.claude/smoke/` before relying on `release-engineer` for autonomous deploys.

Until then, `/pm deploy` should surface this block and refuse to queue anything past
the QUEUE table below.

---

## QUEUE

| Position | Task ID | Title | Type | Priority | Queued At | Status | Notes |
|----------|---------|-------|------|----------|-----------|--------|-------|

---

## IN PROGRESS

| Task ID | Title | Started | ETA | Agent Slot |
|---------|-------|---------|-----|------------|

---

## DEPLOYED (last 10)

| Task ID | Title | Deployed At | Deployed By | Commit/Tag |
|---------|-------|-------------|-------------|------------|

---

## FAILED

| Task ID | Title | Failed At | Reason | Retry? |
|---------|-------|-----------|--------|--------|
