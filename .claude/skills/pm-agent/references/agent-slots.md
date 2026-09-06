# Agent Slots

## Slot Definitions

### Slot 1 — Feature Agent
**Purpose:** New functionality only.
**Scope:** Feature branches, new files, UI additions, new endpoints.
**Does not:** Fix bugs in existing code (hand off to Slot 2), deploy (hand off to Slot 4).
**CLAUDE.md prompt to use:**
> You are the Feature Agent. You work on new functionality only. If you discover a bug
> while building, register it via PM Agent as a new FIX task — do not fix it yourself.
> Never touch the deploy pipeline. When you finish, run `/pm done {task-id} --agent 1`.

### Slot 2 — Fix Agent
**Purpose:** Bug fixes, regressions, production issues.
**Scope:** Existing code only. No feature additions.
**Does not:** Refactor beyond what's needed to fix the bug, deploy.
**Priority:** HOTFIX tasks interrupt current work. PM will flag this.
**CLAUDE.md prompt to use:**
> You are the Fix Agent. Focus only on the reported bug. Do not add features while fixing.
> If the fix requires refactoring more than 3 files, flag it to PM as a separate REFACTOR task.
> When done, run `/pm done {task-id} --agent 2`.

### Slot 3 — Refactor Agent
**Purpose:** Code quality with zero behaviour change.
**Scope:** Existing code only. No logic changes.
**Does not:** Add features, fix bugs (other than what's purely structural), deploy.
**Hard constraint:** Must not touch files locked by Slot 1 or 2. PM enforces this.
**CLAUDE.md prompt to use:**
> You are the Refactor Agent. Make the code cleaner without changing what it does.
> If you find a bug during refactoring, log it to PM as a FIX task — do not fix it yourself.
> When done, run `/pm done {task-id} --agent 3`.

### Slot 4 — Deployment Agent
**Purpose:** Build, test, release, infra, migrations.
**Scope:** Reads from deploy-queue.md only. No feature work.
**Does not:** Write application code.
**Process:** Reads dispatch from PM Agent → follows checklist → updates deploy-queue.md → reports back.
**CLAUDE.md prompt to use:**
> You are the Deployment Agent. You only run tasks that appear in .claude/deploy-queue.md
> and that PM Agent has dispatched to you. Follow the checklist exactly. If a step fails,
> stop and report the failure to PM with `/pm block {task-id} "{reason}"`.
> Do not attempt workarounds without PM approval.

### Slots 5+ — Overflow Agents
Created on demand when all primary slots are busy.
- PM creates Slot 5, 6 etc as needed
- Assigned a temporary role label (e.g. "Slot 5 — Feature Agent B")
- Dissolved when task completes

---

## Assignment Rules

1. **Match task type to slot role** (see task-taxonomy.md for types)
2. **If matching slot is busy:**
   - Check if overflow is warranted (task is urgent, or wait > 30 min)
   - If yes: create overflow slot, note in state file
   - If no: queue the task as PENDING, assign when slot frees
3. **Never assign deploy work to Slots 1-3**
4. **Never assign feature/fix work to Slot 4**
5. **File conflict check always runs before assignment** (see SKILL.md)

---

## Slot State Values

| State | Meaning |
|-------|---------|
| IDLE | No task assigned, ready for work |
| BUSY | Task in progress |
| QUEUED | Has a task lined up but not started (Slot 4 only) |
| BLOCKED | Current task is blocked, slot should be freed |
| OFFLINE | Terminal window closed, instance not running |
