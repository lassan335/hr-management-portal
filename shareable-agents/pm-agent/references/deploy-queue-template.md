# Deployment Queue
_Managed by PM Agent. Deployment Agent reads this file for instructions._

updated_at: {TIMESTAMP}

---

## ⭐ {{DEPLOY_AGENT_NAME}} STANDING MANDATE — verify every deploy via Vercel MCP

**Applies to every deploy, by default, with no per-release reminder needed.**

After pushing to `main`, the Deployment Agent MUST confirm the prod build reached **Ready**
before declaring the deploy verified — using the Vercel MCP (no `VERCEL_TOKEN` required):

1. Load the tool: `ToolSearch "get_deployment vercel"` then select the `*_Vercel__get_deployment`
   tool (the connector may surface as `mcp__claude_ai_Vercel__*` or `mcp__plugin_vercel_vercel__*`).
2. Call `get_deployment`:
   - `idOrUrl`: `{{PROD_URL}}`
   - `teamId`: `{{VERCEL_TEAM_ID}}`
3. Confirm the returned deployment is the **just-pushed commit SHA** (`meta.githubCommitSha`),
   `target: production`, and `state` / `readyState` = **READY**.
   - If `BUILDING`/`QUEUED`: wait and re-poll (~30–60s) until READY or ERROR.
   - If `ERROR`/`CANCELED`: do NOT mark deployed — `/pm block <task-id>` with the build error.
4. Only then record DEPLOYED + Ready-confirmed in this file and run `/pm done`.

Prereq (one-time): the claude.ai **Vercel connector** must be authenticated to your team scope.
If MCP returns `403 forbidden` ("must re-authenticate to this scope"), the connector grant
lapsed — ask the human to reconnect Vercel in Claude → Settings → Connectors. Fallback only if
MCP is unavailable: human confirms Ready in the Vercel dashboard.

---

## ⭐ {{DEPLOY_AGENT_NAME}} STANDING MANDATE — post-deploy browser smoke (MAJOR deploys)

**Applies to every MAJOR deploy (feature release / bundle / anything touching UI or queries),
by default, with no per-release reminder.** Trivial infra-only or docs-only pushes may skip it
(note the skip). The MCP check above confirms the build is *live*; this confirms it *behaves*.

After the Vercel build is confirmed **READY**, run the read-only browser smoke:

```bash
cd .claude/smoke
npm run setup      # first time only (installs playwright; Chromium is cached user-level)
node smoke.mjs     # targets prod; or: node smoke.mjs --base https://<new-deployment>.vercel.app
```

- **Exit 0 / `SMOKE RESULT: N/N passed`** → record "browser-smoke confirmed (N/N)" in the DEPLOYED
  note alongside the Vercel-READY line, then `/pm done`.
- **Exit 1 / any FAILURE** → do NOT declare the deploy verified. `/pm block <task-id>` with the
  failing check(s) from the `FAILURES` list, and open a fix task.

**It is READ-ONLY** — it logs in (handles TOTP 2FA) and asserts the core surfaces + key invariants,
but clicks nothing that writes. **Mutating flows** (record/reverse, settle, approve) remain a
**human or staging-DB** step — never run those against prod from the smoke.

**Credentials** live OUT of the git tree at `~/.claude/{{PROJECT_SLUG}}/smoke-creds` (the script also
accepts `--creds <path>` / `$SMOKE_CREDS`). Never commit them. If login fails with an auth error,
the test account's password or 2FA may have changed — refresh the creds file (see
`.claude/smoke/README.md`).

For a release that adds NEW surfaces, extend `.claude/smoke/smoke.mjs` with release-specific
read-only checks (same `ok(area, name, cond, detail)` pattern) before running — see the README.

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
