# Agent Note: Project-local worktree policy

Status: implemented

English | [中文](2026-09-14-project-local-worktree-policy.zh.md)

## Problem

The `coding` skill originally required a temporary worktree for every coding execution unit, consistent with the project template's "one project-local temporary worktree" instruction and with the skill's own merge and cleanup lifecycle. Commit `66927a3` weakened that requirement to optional ("For larger or high-risk changes, consider a temporary worktree before implementation.").

That wording contradicted the project template, which still declared "one project-local temporary worktree", and contradicted the lifecycle the skill itself retained: the merge, rerun and cleanup steps still operated on a temporary branch and an owned worktree. Because execution treated the worktree as optional, coding runs skipped it, and there was then no project-local worktree available for implementation, validation, commit, merge or cleanup, leaving the skill and the template inconsistent in how execution happened.

## Decision

Coding must create one project-local temporary worktree before implementation. Git Operator creates it under `<project>/.worktrees/<name>`, and the project `.gitignore` must contain `.worktrees/` so the worktree stays untracked.

All implementation, validation and per-step commits happen inside that single worktree. It is a mandatory step of every coding execution unit, not an option reserved for high-risk changes; planning, TDD and review depth remain proportional to change risk. The temporary branch and its owned worktree merge back into the mainline and are deleted only through the existing merge and cleanup lifecycle.

This decision is still current: the worktree requirement is now declared together by the project contract `.ai-workflow/AGENTS.md` (single-sourced from `templates/project/AGENTS.md`), the `coding` skill, the `git-operator` role and `MEMORY.md`. The project-level `AGENTS.md`/`CLAUDE.md` templates mentioned by the original record were superseded by [the project contract and Agent Notes replacement record](./2026-09-16-project-contract-and-agent-notes.md); the rule itself is unchanged.

## Alternatives considered

- **Keep the worktree optional (proportional).** Rejected: it breaks the template's "one project-local temporary worktree" agreement and leaves the skill's merge and cleanup lifecycle with nothing to operate on.
- **Loosen the project template so the worktree becomes optional too.** Rejected: it would remove worktree isolation from every coding run and would weaken the install-time contract and its tests instead of restoring consistency.

## Consequences

- The `coding` skill and the project contract now declare the same mandatory worktree rule, removing the contradiction introduced by `66927a3`.
- Every coding execution is isolated in a project-local worktree, so the per-step commits and the following merge and cleanup steps always have a worktree and branch to operate on.
- `.worktrees/` must exist in the project `.gitignore`; a missing entry is a configuration defect to fix before implementation.
- The proportionality of planning, TDD and review depth is unchanged; only the worktree itself became mandatory.
