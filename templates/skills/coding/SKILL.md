---
name: coding
description: Generate, confirm and execute a versioned JSON DAG from frozen plan documents.
---

# Coding

## Outcome

Generate, confirm and execute a reproducible JSON DAG from one frozen plan. Use the active host explicitly and only its native CLI for the entire run. The local `ai-workflow` runtime owns orchestration; do not call provider APIs or any external workflow framework.

## Preconditions

- The project is initialized and Git state is available for baseline inspection.
- Frozen `spec.md` and `plan.md` share a valid plan ID and digests.
- Validate them with `ai-workflow plan validate --plan <directory>`; planning, task splitting, workflow generation and run-time checks use the same frozen-plan digest protocol.
- Task files, when present, are frozen and cover the plan. Without tasks, generate one plan-wide Task Worker node.
- Host is exactly one of `codex`, `claude`, or `opencode`.

Do not silently repair documents. Return to planning or task splitting when requirements or task scope must change.

## Candidate generation

Run `workflow generate` and deterministically derive:

- task nodes and declared dependencies;
- role from surface;
- exact packet read/write scopes and allowed commands;
- serialization for overlapping, broad or unknown writes;
- maximum concurrency of three;
- timeout, retry and failure policy;
- test, dual-review, context and integration gates;
- frozen input digests.

Validate public JSON Schema, unique IDs, dependency existence, acyclicity, role permissions and scope conflicts before showing a candidate.

The frozen-plan digest protocol is shared with planning and plan-to-tasks. A run must reject any changed or stale `spec.md` or `plan.md` before execution.

## User review and adjustments

Show in one review:

- phase and node summary;
- Mermaid DAG and critical path;
- host, concurrency, timeouts and retries;
- input digests and no-HEAD baseline files when applicable;
- write conflicts, wide/unknown scopes and other risks;
- tests, review gates, repair limit and integration behavior.

Translate user feedback into `adjustment.schema.json`. Permitted operations are node/dependency, concurrency, role, retry, failure-policy and gate changes. Never change REQ/AC, task coverage, read scope or write scope through an adjustment. Validate and redisplay after every change.

## Approval gate

Run `workflow approve` only after explicit user confirmation. The receipt binds workflow digest, plan ID, host and approval time. `run start` must reject:

- missing receipt;
- mismatched workflow digest, plan ID or host;
- changed spec, plan or tasks;
- baseline drift between approval and start.

## Execution lifecycle

The fixed lifecycle is:

1. preflight and receipt/input checks;
2. baseline capture;
3. plan worktree setup by Git Operator;
4. dependency-aware task scheduling;
5. task worktree, File Explorer context, surface implementation and scoped tests;
6. one allowed repair/retest for a task test failure;
7. one task commit using a `$git-message`-generated message and DAG-ordered plan merge;
8. full validation;
9. one Standards Review against root `MEMORY.md` and one Spec Review against frozen artifacts;
10. at most one aggregate repair, followed by affected tests without a second review;
11. non-fast-forward integration into the starting branch and owned-worktree cleanup.

## Role and safety invariants

- File Explorer exclusively searches, traverses, resolves entries/call chains and maintains context files.
- Git Operator exclusively runs all Git commands and owns worktrees.
- Task Worker coordinates but never edits code.
- Backend/Frontend edit only packet write paths.
- Test changes only evidence and keeps screenshots in the packet screenshot directory.
- Reviewers are read-only and use only their designated authority.
- Push, publish, remote mutation, rebase and mixed-host execution are forbidden.
- Command, event, snapshot or path violations pause immediately and are not retried.

## Pause, resume, cancel and cleanup

- Resume only from a validated checkpoint after verifying digests, baseline, worktrees, commits and completed idempotency keys.
- Never repeat a successful side effect.
- Cancel stops new scheduling, terminates child processes and preserves evidence.
- Cleanup accepts only complete or cancelled runs and removes only manifest-owned resources.
- Conflicts or baseline drift pause; never auto-rebase or discard work.

## Completion checklist

Require passing typecheck, lint, unit, integration, build and host-install smoke gates configured by the plan. Produce redacted `summary.md` and `receipt.json` with nodes, commits, tests, reviews, integration and cleanup. A run is complete only after final integration and normal cleanup succeed.
