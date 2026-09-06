# Shareable Claude Code agents

Generic, project-agnostic versions of three subagents. They contain **no**
private credentials, infrastructure IDs, or personal paths — anything specific
to a real project is replaced with a `{{PLACEHOLDER}}` or a "fill this in" block.

## What's here

| File | Role | What you must customize |
|------|------|-------------------------|
| `finsec-analyst.md` | Security code reviewer for financial / FinTech apps | The "Project Context Awareness" block (your stack, money representation, auth, file layout) |
| `release-engineer.md` | Ships code to prod and audits local↔git↔prod↔DB drift | The "Deployment coordinates" + "Credential inventory" blocks (your host, DB, repo) |
| `coordinator.md` | PM that coordinates multiple parallel Claude Code instances | The "Project-specific wiring" block and the companion coordination ledger/skill |

## How to use

1. Copy the file(s) you want into your own project's `.claude/agents/` directory
   (or `~/.claude/agents/` for a personal, all-projects copy).
2. Open each one and fill in every `{{PLACEHOLDER}}` and every block marked
   `FILL IN`. Until you do, the agent works but reasons about a generic stack.
3. Adjust the `tools:` line in the frontmatter — the originals reference
   host-specific MCP tools (e.g. a deploy provider). Keep only the tools you
   actually have available.
4. The `model:` field is a suggestion; change it to taste.

## Notes

- The coordinator agent expects a companion "coordination skill" + two ledger
  files. The generic version describes the contract so you can recreate them;
  it does not ship the original project's skill.
- `memory:` and any agent-memory paths use `~/.claude/...` so they resolve per
  user, not to a hard-coded home directory.
- Nothing here writes secret values anywhere — by design.
