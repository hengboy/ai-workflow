# Agent Note: Workspace execution consistency for status, readiness and root task delivery

Status: implemented

English | [中文](2026-10-08-workspace-execution-consistency.zh.md)

## Problem

`ai-workflow workspace status --plan <directory>` reported `valid: true` merely because the plan and `workspace.yaml` manifest resolved, without checking the manifest against the frozen plan, tasks and schedule. Its `next_repository` followed the `workspace.yaml` manifest array and covered only non-root repositories, so it could not express the frozen delivery order or a pending root task set. The `workspace_root_entry` exposed only `record`, root-owned task delivery had no representation, and readiness was child-only, so nothing in the report could tell whether the root prefix was delivered. The `git-operator` role still described isolated task worktrees and a task-commit merge, contradicting the single-worktree serial-commit execution the coding skill uses.

## Decision

- `ai-workflow workspace status --plan <directory>` validates the workspace manifest against the frozen plan, task set and `tasks/execution-order.yaml` before it reports `valid: true`; a divergent manifest fails with errors and changes no bytes.
- The report's `order` and `next_repository` follow the frozen `tasks/execution-order.yaml` repository first-appearance order, including the reserved `workspace` root entry while its tasks are pending, and never the `workspace.yaml` manifest array order.
- `workspace_root_entry` carries `record`, `tasks_delivered` and a nullable `delivery_commit`; `tasks_delivered` is true when the root owns no task or its record already carries a delivered commit.
- Root-owned tasks are delivered as an optional `root_tasks_commit`, a full lowercase 40- or 64-hex commit SHA, in the same root `implementation.yaml`; a valid `root_tasks_commit` is preferred as the root delivery evidence over a completed root record's `commit` fallback, and `workspace status` checks only its syntax while Git verifies the object at the final gate. After the root prefix merges and its owned worktree is cleaned, the record stays `status: in-progress` with `root_tasks_commit` and no `completed_at` or `commit`, and persists until the last pointer finalization. A finalization-only run executes zero tasks, skips the already-delivered root tasks without re-reviewing them, preserves `started_at` and `root_tasks_commit`, and only then rewrites the record to `completed` with `completed_at` and the final commit; an interrupted finalization retains `root_tasks_commit`. The workflow still has one record with only `in-progress` and `completed`.
- A child record counts as delivered only when its `record` is `completed`, its `slice` is `present`, its `plan_id` matches the frozen plan, and its `delivery_commit` is a full commit SHA. `ready_for_finalization` combines every such child with the root `tasks_delivered`.
- Readiness stays filesystem-only evidence: the root Git Operator verifies every delivery SHA with a read-only `git cat-file -e <sha>^{commit}` existence check before any index mutation, and object existence is not ref reachability. `workspace status` runs no Git.
- Git Operator uses the single `<project>/.worktrees/<name>` worktree for every task and commits each task write scope serially, with no per-task worktrees.
- Planning keeps the reserved `workspace` root a dependency-free `prefix` whose tasks are delivered separately from finalization; the freeze validation in `src/workflow/parse.ts` enforces that the root `depends_on` is empty and rejects a non-empty one, guarded by `tests/integration/plan-workspace-cli.test.ts`. It requires cross-repository acceptance criteria to name their owning repository with exact bounded read-only source checks, never checks out a child automatically, and keeps root owner notes separate from child delivered facts.
- `README.md`, `MEMORY.md`, the project contract and the affected notes state the same facts.

## Alternatives considered

- **Add a third status value or a separate root record file for root delivery.** Declined: one frozen plan is one run with one record, so a third status or a second file would fracture the two-status, one-record invariant and make every reader learn a new shape.
- **Keep readiness child-only and leave root task delivery to the caller.** Declined: the readiness gate would then depend on out-of-band knowledge and could pin a workspace whose root prefix was never delivered.
- **Keep `next_repository` manifest-ordered and child-only.** Declined: the manifest array order is not the frozen delivery order and ignores pending root tasks, so the handoff or finalization would land in the wrong position.
- **Verify delivery SHAs by ref reachability instead of object existence.** Declined: the pin boundary and Git Operator contract use `cat-file` existence before any index mutation, and a reachability policy would change that boundary rather than document it.
- **Rebuild the whole navigation index from discovery.** Declined: the repository ships broad auto-discovered features (`root`, `src`, `tests`), and a discovery rebuild would replace the curated index instead of adding these facts.

## Consequences

- The status report, the readiness gate and the single-record root delivery now agree across `README.md`, `MEMORY.md`, the project contract and the shipped skills.
- `workspace status` stays filesystem-only and now fails closed on a divergent manifest, so a mismatched `workspace.yaml` can no longer look ready.
- `root_tasks_commit` is a full lowercase 40- or 64-hex SHA that appears only in the root `implementation.yaml`, is written only by a root workspace session, and takes precedence over a completed root `commit` as root delivery evidence; child records keep their existing shape, while the reserved root `workspace_root_entry` gains `tasks_delivered` and `delivery_commit`.
- This record partially supersedes the child-only readiness and advisory `next_repository` facts in [the workspace session handoff record](./2026-10-08-workspace-session-handoff.md), the current `workspace status` fact in [the workspace split distribution handoff record](../process/2026-10-02-workspace-distribute-handoff.md), and the `workspace status` and root-delivery facts in [the submodule workspace delivery record](../architecture/2026-09-30-submodule-workspace.md), and adds the root delivery phase to [the plan implementation record](../process/2026-09-22-plan-implementation-record.md); each record keeps its decision, rationale and history, and its current facts point here.
- Execution is guarded by `tests/integration/workspace-status-cli.test.ts`, `tests/integration/workspace-finalization-git.test.ts`, `tests/integration/plan-workspace-cli.test.ts`, `tests/behavior/worktree-policy.test.ts` and `tests/behavior/implementation-record.test.ts`; the evidence scope is the shipped text, the CLI status cases and the finalization Git guard, not a live agent workflow.
