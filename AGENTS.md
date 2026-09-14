# ai-workflow repository guide

ai-workflow is a self-contained macOS/Node.js 22 CLI that installs planning and context skills plus native role agents for Codex, Claude Code and OpenCode. Planning freezes `spec.md` and `plan.md`; coding runs in a project-local temporary worktree; navigation is JSON-authoritative. This file describes this repository and routes readers to its sources of truth. It does not restate the sub-agent contract.

## Start here

- `MEMORY.md` records this repository's current standards.
- `.ai-workflow/index/navigation.json` is the authoritative navigation index, and `.ai-workflow/index/navigation.md` is generated from it. Read both before repository work.
- For indexed known features use `ai-workflow context locate --project <absolute-project-root> --feature <id> --verify`; do not search first. A missing or empty index is normal for a new project and does not block work when the frozen plan supplies an explicit boundary; `stale` or `invalid` still require bounded discovery or index repair.
- Frozen `spec.md` and `plan.md` use the shared digest protocol; validate with `ai-workflow plan validate --plan <plan-directory>` after planning and before task splitting or coding.
- Local architecture decision records live under `.ai-workflow/adr/`. List them with `ai-workflow adr list --project <root>`; there is no stored index file.

## User-level agent contract

The sub-agent contract is user-level, not a project file. `ai-workflow install` writes and refreshes one marker block between `<!-- ai-workflow:begin -->` and `<!-- ai-workflow:end -->` in each host's global instruction file: opencode `~/.config/opencode/AGENTS.md`, claude `~/.claude/CLAUDE.md` and codex `~/.codex/AGENTS.md`. The block is single-sourced from `templates/contract/AGENTS.md` and applies only in a project whose root contains `.ai-workflow/`. Do not restate or fork the contract in this repository. `CLAUDE.md` references this file.

## Maintenance

Navigation JSON is authoritative. Updating `MEMORY.md` and `.ai-workflow/index/navigation.json` is mandatory and immediate whenever architecture, ownership, agent responsibilities, public symbols, paths or workflow rules change; regenerate and validate `navigation.md` in the same change.
