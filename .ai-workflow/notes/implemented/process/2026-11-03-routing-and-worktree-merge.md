# Agent Note: Feature-first routing and worktree integration

Status: implemented

English | [中文](2026-11-03-routing-and-worktree-merge.zh.md)

## Problem

The earlier routing rule let a small new capability use the Direct route whenever its intent was clear, bounded and had one observable outcome, so a new user-visible feature could skip Planning and the dual-axis review on a size judgment alone. The worktree rule said only that the temporary branch and its owned worktree merge back into the mainline, and the conflict rule stopped the run on any conflict with no automatic resolution. A Direct or Mechanical change therefore had no recorded integration target, and an ordinary target-branch advance before delivery could be mistaken for source drift or treated as an unresolvable conflict.

## Decision

- Every request is still classified in one line before work starts, and the class remains the only routine review trigger. A new feature or user-visible capability is always a Planned change, even when its scope looks small or has one observable outcome.
- Direct is limited to a bounded adjustment of existing behavior or a defect fix with clear intent and one observable outcome that adds no new user-visible capability. Mechanical stays a typo, copy, comment, formatting or test-only adjustment with no observable behavior change.
- Direct and Mechanical still execute the full coding unit and keep the mandatory project-local temporary worktree at `<project>/.worktrees/<name>`: implementation, validation and commits happen inside it, and the result merges back into the recorded target branch. Only the Planning artifacts and the dual-axis review are skipped.
- At worktree creation Git Operator records the branch checked out at that moment and its starting commit as the integration target. A detached starting checkout has no target branch, so it stops before implementation with a bounded support request.
- Integration is a non-fast-forward merge of the worktree branch into that recorded target branch, and the delivery merge SHA is recorded separately from the accepted source HEAD. A target-branch advance is not source drift while the source HEAD, repository and worktree identity still match accepted evidence; a moved or dirty source HEAD still refuses integration.
- On a merge conflict Git Operator reconciles every conflicted hunk by preserving both sides' changes, never chooses ours or theirs wholesale and never rebases, forces, resets or amends; the affected checks rerun after resolution. A conflict that cannot preserve both sides, or a failing post-resolution check, aborts only the in-progress merge, retains the owned worktree and branch, and reports blocked with the conflicted paths, resolution evidence and the failing check.
- A workspace repository delivery follows the same recorded-target and preserve-both policy, and its reviewed commit remains the reviewed source HEAD. The policy is stated in `templates/project/AGENTS.md` with its byte-identical mirror `.ai-workflow/AGENTS.md`, `templates/skills/coding/SKILL.md`, `templates/skills/coding/references/workspace.md`, `templates/skills/planning/SKILL.md`, `templates/agents/git-operator.md` and `README.md`.

## Alternatives considered

- **Keep Direct open to small new capabilities.** Declined: the previous rule let a new user-visible feature skip Planning on a bounded-scope judgment, which is exactly the classification ambiguity this policy removes.
- **Keep stopping on any conflict.** Declined: it discards a resolvable delivery and turns routine concurrent target-branch work into a dead end; preserve-both with rerun keeps both sides' behavior and still blocks when preservation is impossible.
- **Resolve conflicts by choosing one side wholesale or rebasing.** Declined: a wholesale choice silently drops the other side's delivered behavior, and rebasing, forcing, resetting or amending rewrites accepted history.
- **Treat any target-branch advance as source drift.** Declined: refusing an advanced target would block ordinary concurrent work, while the accepted source HEAD, repository and worktree identity are the evidence that must actually match.
- **Treat automatic conflict resolution as a new semantic review.** Declined: resolution is integration evidence rather than a second review, so claiming reviewed status for the merge result would overstate what the dual-axis review judged.

## Consequences

- The Direct scope is narrowed: a request for a new user-visible capability now enters Planning even when it is small, while bounded adjustments to existing behavior and defect fixes keep the direct route.
- The Mechanical route is unchanged: a typo, copy, comment, formatting or test-only adjustment still runs only the narrowest relevant check.
- The worktree, commit and merge cost is retained for Direct and Mechanical changes, so the change removes classification and integration ambiguity rather than execution overhead.
- Blocked recovery is explicit: an unresolvable conflict or a failing post-resolution check keeps the owned worktree and branch, commits no conflict markers or partial resolution, and reports the conflicted paths, resolution evidence and the failing check.
- Static content tests in `tests/behavior/change-routing.test.ts`, `tests/behavior/worktree-policy.test.ts`, `tests/behavior/coding-v2-content.test.ts` and `tests/behavior/workspace-workflow-content.test.ts` guard the feature-first classification, the retained worktree and merge-back, the recorded target, preserve-both resolution, affected-check reruns, blocked handling, the absence of the old stop-on-conflict instruction and workspace alignment. This is static shipped-content evidence and makes no live-model compliance claim.
- No runtime classifier, schema field, CLI command or persistent format changes, and existing task, workspace and implementation-record shapes stay compatible.
- [Change routing](./2026-09-22-change-routing.md) is partially superseded: its Direct definition is replaced by the feature-first classification, while its routing rationale, alternatives and consequences remain current. [Project-local worktree policy](./2026-09-14-project-local-worktree-policy.md) is also partially superseded: its mainline merge-back wording is replaced by the recorded integration target and the preserve-both conflict policy, while its mandatory-worktree decision, alternatives and consequences remain current.
