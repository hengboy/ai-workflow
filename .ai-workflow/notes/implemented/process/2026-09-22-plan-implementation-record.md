# Agent Note: Plan implementation record

Status: implemented

English | [中文](2026-09-22-plan-implementation-record.zh.md)

## Problem

Coding runs left no minimal record of whether a frozen plan was implemented and when it started and finished. The governing text banned every workflow manifest and run record without exception, so a maintainer could not distinguish a completed implementation from one that started and never finished, nor tell from a single file when the run began and when it ended. The project-local worktree policy in [the worktree policy record](./2026-09-14-project-local-worktree-policy.md) and the ignored-state sharing rule in [the ignored-state sharing record](./2026-09-14-share-ignored-state-into-worktree.md) already made `.ai-workflow/plans/` visible and single-source at the project root, but no permitted file under that boundary carried the implementation timing.

## Decision

- The single permitted run record is `<project>/.ai-workflow/plans/<planId>/implementation.yaml`. Ownership stays with the `coding` orchestrator for writes, with `git-operator` for worktree materialization, and with `documentation-maintainer` for the governing text; the file boundary is always resolved at the project root and stays gitignored local state.
- Before the first implementation step the file holds `plan_id`, `status: in-progress` and an ISO 8601 `started_at`, with no `completed_at`.
- After the final merge and the cleanup of only the run-owned worktree and branch, the same file becomes `status: completed` with an ISO 8601 `completed_at` and the final commit SHA, preserving `plan_id` and `started_at`. The update is idempotent, and when the start record is missing it still writes a valid completed record that omits `started_at`.
- The record has only the two status values `in-progress` and `completed`. An interrupted run stays at `status: in-progress` with only the start fields and never a failure or abandonment reason. Only a frozen plan creates this record; a small fix without a frozen plan creates no record.
- The standard is stated together by the `coding` skill in `templates/skills/coding/SKILL.md`, the project contract in `templates/project/AGENTS.md` and `.ai-workflow/AGENTS.md`, the project memory in `templates/project/MEMORY.md` and `MEMORY.md`, and `README.md`. No other workflow manifest or run record may be generated, and `ai-workflow plan validate` and `ai-workflow plan pairing` neither require nor read `implementation.yaml`.

## Alternatives considered

- **Write a per-step or per-task progress log with failure reasons and durations.** Declined: the approved scope asks for one minimal timing record a maintainer can read at a glance, and a running log would reintroduce the run-record surface the ban was meant to remove.
- **Add a new CLI subcommand, schema or migration for the record.** Declined: no new command or format is needed when the record is plain local state that existing readers ignore, and keeping `ai-workflow plan validate` and `ai-workflow plan pairing` unchanged avoids a compatibility surface.
- **Give the record `.zh.md` and `.i18n.yaml` siblings and require it in plan validation.** Declined: the record is not a planning artifact, and requiring siblings or validation would turn local runtime metadata into a frozen planning gate.
- **Backfill records for past plans and small fixes without a frozen plan.** Declined: history without observed start and completion timing cannot be reconstructed truthfully, and unplanned fixes have no frozen `plan_id` to record.
- **Add a terminal failure or abandonment status.** Declined: an interrupted run is intentionally indistinguishable from an unfinished one, so `in-progress` remains the only non-terminal state and a later successful run simply rewrites the same path as completed.

## Consequences

- A maintainer reads one file at `<project>/.ai-workflow/plans/<planId>/implementation.yaml` to decide whether a plan was implemented, when it started and when it finished, with no per-step process log to consult.
- Coding keeps its blanket ban with exactly one exemption: this `implementation.yaml` is the only permitted run record, so any additional manifest or run record is still a violation.
- Interrupted work never writes a failure state, which keeps the file truthful but means the reason for an interruption must be found outside this record.
- Installed host skills and agents pick up the new text only after the next host install or profile activation, so the runtime record is observed on the next real implementation after rollout rather than produced by this plan itself.
- No active note is superseded in full or in part: [the worktree policy record](./2026-09-14-project-local-worktree-policy.md), [the ignored-state sharing record](./2026-09-14-share-ignored-state-into-worktree.md) and [the project contract and Agent Notes replacement record](./2026-09-16-project-contract-and-agent-notes.md) remain current, and this record only adds the single exemption they did not previously allow.
