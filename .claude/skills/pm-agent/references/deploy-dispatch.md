# Deploy Dispatch

How PM Agent writes instructions for Deployment Agent (Slot 4).

## When to Dispatch

After `/pm deploy {task-id}`:
1. Validate task is DONE or READY-FOR-DEPLOY
2. Check for file conflicts with anything in the current deploy queue
3. Write the dispatch block to deploy-queue.md IN PROGRESS section
4. Print the dispatch to chat so user can paste into Slot 4 terminal

## Dispatch Template

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 DEPLOY DISPATCH — Slot 4 (Deployment Agent)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Task ID:     {task_id}
Title:       {task_title}
Type:        {FEATURE | FIX | REFACTOR}
Branch:      {branch_name}
Priority:    {NORMAL | HIGH | HOTFIX}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PRE-DEPLOY CHECKS
  □ All tests passing on branch?
  □ PR / code review done?
  □ Database migration needed? {YES — file: {migration_file} | NO}
  □ Environment variables changed? {YES — see notes | NO}
  □ Feature flag needed? {YES — {flag_name} | NO}

DEPLOY STEPS
  □ git checkout main && git pull
  □ git merge {branch_name}
  □ {test_command}
  □ {build_command}
  □ {deploy_command}
  □ Tag release: git tag v{version} && git push --tags
  □ Smoke test: {smoke_test_description}

POST-DEPLOY
  □ VERIFY VERCEL READY (default mandate — no VERCEL_TOKEN needed):
      ToolSearch "select:mcp__claude_ai_Vercel__get_deployment", then
      get_deployment(idOrUrl="{{PROD_URL}}", teamId="{{VERCEL_TEAM_ID}}").
      Confirm meta.githubCommitSha == this deploy's commit, target=production, state=READY.
      BUILDING/QUEUED → re-poll ~30–60s. ERROR/CANCELED → /pm block instead of marking deployed.
      (See deploy-queue.md "{{DEPLOY_AGENT_NAME}} STANDING MANDATE". 403 → human re-auths the Vercel connector.)
  □ Confirm {key_metric} looks normal
  □ Update deploy-queue.md: set status → DEPLOYED + Ready-confirmed, add commit hash
  □ Run: /pm done {task_id} --agent 4

ON FAILURE
  □ Do NOT retry automatically
  □ Run: /pm block {task_id} "{error summary}"
  □ PM Agent will coordinate resolution

Notes:
{any_special_instructions}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Conflict Detection

Before queuing a deploy task, PM checks:
- Is the same branch already in the IN PROGRESS section? → Block, different branch must merge first
- Does this task's files overlap with a currently-deploying task? → Warn, ask user to sequence
- Is this a HOTFIX? → Jump to position #1 in queue, displace NORMAL priority items

## Priority Rules

| Priority | Queue Behaviour |
|----------|----------------|
| HOTFIX | Immediate — goes to front of queue |
| HIGH | Next after any in-progress item |
| NORMAL | End of queue |

## What PM Agent Does NOT Do in Dispatch

- PM does not determine the version number (Deployment Agent reads from package.json or tags)
- PM does not write the smoke test steps (user adds these to the task when registering)
- PM does not merge PRs (Deployment Agent does this, or user does it manually before dispatching)

## Rollback Protocol

If Deployment Agent reports failure after partial deploy:
1. PM sets task status → FAILED-DEPLOY
2. PM prints rollback instructions based on what completed before failure
3. User decides: retry / rollback / manual fix
4. PM does not auto-rollback — too risky without human confirmation
