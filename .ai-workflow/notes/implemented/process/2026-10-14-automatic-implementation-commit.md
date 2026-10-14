# Agent Note: Automatic implementation commit

Status: implemented

English | [中文](2026-10-14-automatic-implementation-commit.zh.md)

## Problem

Dispatching the scoped local commit was already required: the `coding` skill told the session to self-check once per step and dispatch Git Operator for its scoped commit, and the contract's Orchestration section required dispatching Git Operator after the Documentation Maintainer returned. What was insufficiently stated was that once an implementation is authorized the delegation happens automatically for planned, direct and mechanical work, that no separate commit confirmation follows, and that `done` is gated on the commit evidence and SHA. Without those statements a run could present a change as finished and leave the commit to a later prompt, and a no-scoped-diff execution unit had no stated no-change evidence route.

## Decision

- The project contract `templates/project/AGENTS.md` and its tracked `.ai-workflow/AGENTS.md` state that once an authorized implementation passes its relevant checks and any applicable existing gate, the primary orchestrator automatically delegates the scoped local commit to the `git-operator` sub-agent (Git Operator) for planned, direct and mechanical changes, with no separate commit confirmation, and gates `done` on the resulting commit SHA or on verified no-change evidence with the current HEAD SHA.
- The `coding` skill's `## Change routing` connects the direct and mechanical worktree and Git Operator commit to that automatic gate, its `## Verification and Commit` requires the automatic delegation while preserving review timing and split-phase serial commits, and its `## Completion checklist` gates `done` on the returned commit SHA or on Git Operator's verified no-change evidence with the current HEAD SHA when the execution unit leaves no scoped diff, and reports a failed or blocked commit as `blocked` or `failed`.
- The `git-operator` role accepts plan/task IDs only for planned work and takes the request's explicit scoped outcome for a direct or mechanical change without demanding a missing `spec.md`, `plan.md` or task file; it accepts the primary's authorized automatic commit packet without a new user confirmation, invokes the installed `$git-message` skill with the scoped diff and evidence as before, returns the commit SHA, and when no scoped diff exists it verifies that and returns no-change evidence with the current HEAD SHA instead of fabricating an empty commit.
- The commit mandate is implementation completion, not a planning-only session: a planning session still ends with its frozen-plan handoff and starts no implementation or commit.
- `tests/behavior/change-routing.test.ts` guards the shipped contract, coding skill and Git Operator text so a regression that drops the automatic commit or the commit-backed done gate fails the suite.

## Alternatives considered

- **Keep the commit optional or manual after direct work.** Declined: an optional commit loses the required closure, because a run could report completion without any commit and the user would still have to request it.
- **Make the commit automatic only for planned work.** Declined: a uniform automatic local commit for planned, direct and mechanical changes follows the existing rule that all three execute as one coding execution unit with a Git Operator commit, so a class-specific gate would add a distinction the workflow does not otherwise make.

## Consequences

- An authorized implementation now ends in a scoped local commit through the `git-operator` sub-agent, or in verified no-change evidence with the current HEAD SHA when it leaves no scoped diff, and `done` requires that evidence; a failed or blocked commit is reported as `blocked` or `failed`. This preserves the existing `kind: no-change` checkpoint boundary instead of forcing an empty commit.
- [Change routing](./2026-09-22-change-routing.md) remains current: it owns the direct, mechanical and planned classification and the retained execution unit, and this record only makes the existing Git Operator commit automatic and completion-gating.
- [The Planning and coding session boundary](./2026-09-23-planning-coding-session-boundary.md) remains current: a planning-only session still ends with its handoff and starts no implementation or commit, so this record elaborates implementation completion rather than reopening that boundary.
- The commit stays local with no new Git permission: the role still stages only explicit paths, invokes `$git-message`, preserves unrelated changes and performs no remote mutation.
