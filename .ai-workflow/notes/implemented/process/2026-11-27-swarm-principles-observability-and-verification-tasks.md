# Agent Note: Swarm principles as read-only observability and DAG verification tasks

Status: implemented

English | [中文](2026-11-27-swarm-principles-observability-and-verification-tasks.zh.md)

## Problem

A split plan could run tasks in parallel, but nothing reported how much parallelism its schedule actually used or what review, repair and integration work cost. An operator comparing a serial schedule with a parallel one, or a parallel boundary with and without independent verification, had no deterministic read-only evidence, so the tempting remedy was a second orchestration runtime with its own coordinator, shared board and per-worker worktrees.

## Decision

- Static schedule efficiency is exposed read-only: `parallel_width` (the widest schedule phase), `critical_path_ratio` (`critical_path_length / task_count`) and `estimated_parallel_speedup` (`task_count / critical_path_length`) join the plan metrics reported by `plan validate` and `plan report`. Both ratios are rounded to four decimals and report `0` when their denominator is absent, so a plan without tasks or without a critical path yields no `NaN` or `Infinity`.
- Two advisory `plan lint` warnings target `plan.md`: one `plan-schedule-serial` when at least three tasks run one at a time and the critical-path ratio reaches `0.8`, and one deduplicated `parallel-tasks-without-integration-verify` naming every parallel implementation phase that no strictly later `surface: test` task covers by depending on at least two of its implementation tasks. Lint reads a valid frozen `tasks/execution-order.yaml` and otherwise falls back to a read-only `depends_on` depth grouping that ignores unknown IDs and skips both warnings on a cycle; neither warning changes `plan validate`, an exit code or a gate.
- Boundary evidence is recorded through one allowlisted command, `ai-workflow execution event <type> --plan <directory> [--result <value>] [--boundary <name>]`, for `review.started`, `review.completed`, `repair.completed` and `validation.completed`. It requires a running run, trims and validates both values, requires a result for `validation.completed`, stores only the `result` and `boundary` payload keys, refuses an invalid request with exit 1 and no write, and reports a storage failure as exit 0 with `event_id: null` and a warning while `implementation.yaml` stays byte-identical.
- `execution analytics` adds `phase_wall_clock`, `review_duration_seconds`, `repair_rounds`, `integration_failure_rate` and `cost_per_accepted_task`. Every value derives only from stored run, event and frozen schedule data, a workspace slice counts only its own repository's tasks in a phase, and absent evidence reports `N/A` or `0` instead of a negative or invented value.
- Verification is a task in the frozen graph. Planning requires a downstream `test` verification step with exact integration-test write paths whenever parallel implementation steps share a cross-task integration boundary, and plan-to-tasks derives a downstream `surface: test` task whose `depends_on` names the verified implementation tasks, whose `write_scope` holds only frozen test paths, and whose `test_commands` prove the shared boundary.
- The execution model is otherwise unchanged: one worktree, the frozen phase schedule, serial task commits and the final dual-axis review. Verification adds no role, Board, per-phase review trigger or gate.
- The structural cost guard stays explicit: no model call, no network call, no periodic scan, no prompt, reasoning or tool-call payload, and read-only queries.

## Alternatives considered

- **A full Swarm runtime with a Coordinator, shared Board, dynamic decomposition and per-worker worktrees.** Declined: it conflicts with the single worktree, frozen schedule, serial commit and dual-axis review decisions and replaces cheap serial integration with multi-branch conflict resolution.
- **Read-only analytics without the boundary recorder.** Declined: `review_duration_seconds` and the pre-repair `integration_failure_rate` would stay permanently `N/A` on single-repository runs.
- **Four separate `execution` event subcommands.** Declined: one allowlisted command keeps the CLI and its validation surface minimal.
- **A hard `plan validate` requirement for downstream verification tasks.** Declined: verification pays only when prevented rework exceeds its cost, so an advisory lint warning avoids redundant tests on independent tasks.

## Consequences

- An operator compares schedule efficiency and rework cost from deterministic read-only output without a second runtime, and every new value is additive with `N/A` or `0` fallbacks for legacy plans, runs and events.
- A missing, late or failed boundary write degrades analytics to `N/A` and a visible warning; it never blocks a run or rewrites the authoritative implementation record.
- Verification adds prompt text and a scheduled test task, never a new role or review trigger; a parallel group without a shared boundary gains no nominal verification task.
- No supersession: [the plan write-scope completeness record](2026-11-16-plan-write-scope-completeness.md) keeps its exact-inventory, derived-scope and amendment decisions, and a verification task's `write_scope` derives from that same frozen inventory; [the task execution order record](2026-09-25-task-execution-order.md) keeps its frozen-schedule, no-fallback and single-worktree decisions, and a verification task is scheduled by the same phase derivation.
- The boundary recorder and the new analytics extend [the execution observability record](../architecture/2026-11-17-execution-observability-resilience.md) without superseding it: that record keeps the program-owned overlay, the authoritative record and the cost guard.
- Re-evaluate when a measured comparison shows the advisory warnings cannot distinguish a useful serial schedule, when answered review latency and integration-failure data make the boundary recorder unnecessary, or when a second runtime could preserve the single-worktree, serial-commit and dual-axis review guarantees.
