# Task Taxonomy

PM Agent uses this to classify tasks and route them to the right agent slot.

## Task Types

### FEATURE
New functionality, UI additions, API endpoints, new data models.
Keywords: add, build, create, implement, new, design, introduce
→ Default slot: Feature Agent (Slot 1)

### FIX
Bug fixes, regressions, error handling, edge cases, production incidents.
Keywords: fix, broken, bug, error, crash, incorrect, regression, hotfix
→ Default slot: Fix Agent (Slot 2)

### REFACTOR
Code quality improvements with no behaviour change. Cleanup, rename, restructure.
Keywords: refactor, clean up, restructure, rename, move, reorganise, extract, simplify
→ Default slot: Refactor Agent (Slot 3)
⚠️ Rule: Must not touch files currently locked by Feature or Fix agents.

### DEPLOY
Build, release, infra, environment setup, migration runs, version tagging.
Keywords: deploy, release, ship, build, migrate, tag, publish, push to production
→ Slot: Deployment Agent (Slot 4) only, via deploy queue

### REVIEW
Code review, test writing, documentation updates, PR preparation.
Keywords: review, test, document, write tests, PR, pull request, docs
→ Can go to any idle slot

### RESEARCH
Spike work, prototype, feasibility check, technology evaluation.
Keywords: investigate, spike, explore, prototype, evaluate, research, POC
→ Default slot: any idle slot; note as time-boxed

## Routing Priority

1. DEPLOY → always Slot 4, always via queue
2. HOTFIX (FIX with production impact) → Slot 2, interrupt current task if needed
3. FEATURE, FIX, REFACTOR → assign to matching slot; if busy, assign to next idle
4. REVIEW, RESEARCH → assign to any idle slot

## File Conflict Rules

Before routing any task, PM checks:
- Does this task's expected file scope overlap with any locked files?
- If YES → warn, do not assign until conflict is resolved
- REFACTOR tasks especially must be checked (they touch many files)

## Multi-Slot Tasks

Some tasks are too large for one agent. PM splits them when:
- Estimated duration > 2 hours
- More than 5 unrelated files would be locked simultaneously
- The task spans multiple layers (e.g. API + frontend + DB migration)

Split format: T-{date}-{NNN}-A, T-{date}-{NNN}-B etc. with dependency noted.
