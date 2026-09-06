# Deployment Runbook — HR Management Portal (Kinbidhoo School)

_Source of truth for the release-engineer agent (`.claude/agents/release-engineer.md`)
and for humans doing a manual deploy. Read this file first; it overrides that
agent's prompt if they ever conflict. Update this file (and commit it) at the
end of every deploy-related run — durable infra facts belong here, not in
agent memory or prose._

## Status: hosting not yet chosen — no production deploy has happened

This is a fresh project. Local git only, no remote, no hosting provider, no
managed database, no CI. Everything below the topology section is a
**template to fill in**, not current fact — do not treat it as configured.

## The deployment topology

- **App shape:** npm workspaces monorepo — `frontend/` (static Vite build),
  `backend/` (persistent Node/Express process, NOT serverless-function
  shaped as written — it holds a long-lived `chokidar` file watcher and a
  Prisma connection pool). Plan hosting accordingly: the backend needs a host
  that runs a long-lived process (e.g. Render, Railway, Fly.io, a school-owned
  VM/server), not a bare Vercel serverless-functions deploy.
- **Database:** PostgreSQL via Prisma. Local dev uses `docker-compose.yml` at
  the repo root (a throwaway container) — this is NOT connected to whatever
  production Postgres instance eventually gets provisioned.
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
- **Database:** *(none yet — needs a managed PostgreSQL provider)*
- **Git remote:** *(none yet — local git only)*

Fill these in — with real values read from the repo's config files and the
secrets store at deploy time, never hardcoded here — once a hosting decision
is made. Until then, `/pm deploy` should treat any deploy request as blocked
on this decision (see `.claude/deploy-queue.md`).

## Credential & key inventory (names/locations only — NEVER values)

| Variable | Purpose | Where it lives (fill in once deployed) |
|---|---|---|
| `DATABASE_URL` | Postgres connection string | *(TBD — host's env panel / secrets manager)* |
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

## Known residual findings from security review (not yet remediated)

Tracked here so they aren't lost before a first real deploy — see
`.claude/agents/finsec-analyst.md`'s review history for full detail:

- No CSRF token (relies on `SameSite=Lax` + strict CORS) — acceptable for
  now, revisit before wider rollout.
- `uuid`-via-`exceljs` transitive dependency has an open moderate advisory
  (buffer-bounds-check in `uuid` <11.1.1) with no non-breaking fix available;
  low exploitability here since the app never calls `uuid` directly or passes
  attacker-controlled buffers into it. Re-check `npm audit` periodically.
