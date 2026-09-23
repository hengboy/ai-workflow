# Agent Note: Change routing

Status: implemented

English | [中文](2026-09-22-change-routing.zh.md)

## Problem

The workflow had no explicit routing rule, so every request could look like a planning candidate. The `coding` skill required an approved task and its preconditions read the frozen `spec.md` and `plan.md`, the `planning` skill stated no entry criteria, and the project contract described only the planned flow. A small frontend style change with matching test updates therefore prompted Planning and the dual-axis review even though nothing needed clarification and no spec existed. Small requirements, feature adjustments and defect fixes had no reachable direct path, while [the worktree policy record](./2026-09-14-project-local-worktree-policy.md) applied its execution cost to every coding unit regardless.

## Decision

- The project contract in `templates/project/AGENTS.md` and `.ai-workflow/AGENTS.md` states a Change routing section: every request is classified before work starts and the class decides the workflow.
- Direct change: a small requirement, feature adjustment or defect fix with clear, bounded intent and one observable outcome is implemented directly without Planning, without `spec.md`, `plan.md` or task files, and without the dual-axis review; the relevant checks run and a defect gains one focused regression test.
- Mechanical change: a typo, copy, comment, formatting or test-only adjustment with no observable behavior change runs only the narrowest relevant check.
- Planned change: a new feature, unclear or contested requirements, more than one materially different design, or a change to a public interface, persistent format, cross-module or cross-stack behavior, migration, compatibility or the project contract runs Planning first and keeps the dual-axis review gate.
- The `coding` skill description and its Codex catalog metadata drop the approved-task wording, keep the worktree and Git Operator execution unit, record the class at intake and state that a direct or mechanical change creates no implementation record; the `planning` skill description and body restrict Planning to planned changes and forbid restating a settled request.
- `tests/behavior/change-routing.test.ts` guards the shipped contract, skill descriptions, metadata, memory template and README text, so an edit that reintroduces the approved-task bias fails the suite.

## Alternatives considered

- **Keep the implicit behavior and rely on agent judgment.** Declined: the observed result routed a clear small fix to Planning, because the shipped descriptions and preconditions offered no direct path.
- **Route by file count or diff size.** Declined: blast radius is a consequence, not the criterion; a one-line public-interface change needs Planning while a multi-file copy change does not.
- **Relax the worktree and Git Operator execution unit for direct changes.** Declined: the reported overhead was Planning and the dual-axis review, and keeping the single Git entry point preserves the existing invariant.
- **Skip verification entirely for very simple changes.** Declined: even a mechanical change keeps the narrowest relevant check, and never weakening tests stays mandatory.

## Consequences

- A small requirement, feature adjustment or defect fix no longer prompts Planning; it is implemented directly with its relevant checks.
- Every request carries a stated class, so an agent that routes a small change to Planning or labels a planned change direct is contradicted by the shipped text.
- Direct and mechanical changes still create the worktree and commit through Git Operator, so the change reduces planning and review overhead, not execution overhead.
- [The implementation record](./2026-09-22-plan-implementation-record.md) and [the worktree policy record](./2026-09-14-project-local-worktree-policy.md) remain current; no active note is superseded, and this record adds only the missing classification.
