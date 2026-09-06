# Output Formats

## Status Dashboard (`/pm status`)

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🗂️  PM AGENT — {project_name}
Updated: {timestamp}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

AGENTS
  Slot 1 — Feature Agent    🟢 IDLE
  Slot 2 — Fix Agent        🔴 BUSY → T-2026-06-22-001 (auth bug fix)
  Slot 3 — Refactor Agent   🟢 IDLE
  Slot 4 — Deployment Agent 🟡 QUEUED (2 in queue)

IN PROGRESS (1)
  T-2026-06-22-001  [FIX]  Fix login timeout on mobile  → Slot 2
    Files: src/auth/session.ts, src/auth/middleware.ts
    Started: 14:30 · ETA: unknown

BLOCKED (0)
  —

DEPLOY QUEUE (2)
  #1  T-2026-06-21-003  [FEATURE]  Dark mode toggle     → READY
  #2  T-2026-06-21-005  [FIX]     CSV export crash      → READY

COMPLETED TODAY (3)
  T-2026-06-22-000  Navbar spacing fix          ✅
  T-2026-06-21-009  API rate limit headers      ✅
  T-2026-06-21-008  Dashboard skeleton loader   ✅

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Task Card (on `/pm task` registration)

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ TASK REGISTERED
ID:      T-2026-06-22-002
Title:   Fix payment webhook signature validation
Type:    FIX
Slot:    2 — Fix Agent  (was IDLE)
Files:   src/webhooks/stripe.ts (expected)
Queued:  2026-06-22 15:04
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Start this task in your Fix Agent terminal window.
```

## Conflict Warning (file lock collision)

```
⚠️  FILE CONFLICT DETECTED
New task:    T-2026-06-22-003  (Refactor auth module)
Conflicts with: T-2026-06-22-001 (Slot 2 — Fix Agent)
Shared file: src/auth/session.ts

Options:
  A) Wait — Slot 2 ETA unknown. Check with /pm status later.
  B) Scope change — exclude src/auth/ from refactor task now, add it later.
  C) Force assign — accept merge conflict risk (not recommended).

Reply with A, B, or C.
```

## Deploy Dispatch (sent to Deployment Agent)

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 DEPLOY DISPATCH — Slot 4 (Deployment Agent)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Task ID:    T-2026-06-21-003
Title:      Dark mode toggle
Type:       FEATURE
Priority:   NORMAL
Branch:     feature/dark-mode-toggle
Tests:      Run full suite before deploy
Migration:  None

Checklist:
  □ Pull latest main
  □ Merge feature branch
  □ Run: npm test
  □ Run: npm run build
  □ Tag: v{next_version}
  □ Deploy to staging
  □ Smoke test: toggle dark mode in settings
  □ Deploy to production
  □ Update deploy-queue.md: mark DEPLOYED with commit hash

On completion: run /pm done T-2026-06-21-003 --agent 4
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Agent Slots View (`/pm agents`)

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🤖 AGENT SLOTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Slot 1  Feature Agent     🟢 IDLE        No task assigned
Slot 2  Fix Agent         🔴 BUSY        T-2026-06-22-001
Slot 3  Refactor Agent    🟢 IDLE        No task assigned
Slot 4  Deployment Agent  🟡 QUEUED      2 tasks waiting
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Free slots: 2   (/pm task to assign work)
```
