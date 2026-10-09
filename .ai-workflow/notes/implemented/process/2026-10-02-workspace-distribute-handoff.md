# Agent Note: Workspace split distribution handoff

Status: implemented

English | [中文](2026-10-02-workspace-distribute-handoff.zh.md)

## Problem

A cross-repository workspace plan could be split without its slices being written: `ai-workflow workspace distribute --plan <directory>` handed each participating repository its slice only when someone ran it explicitly, and neither the `planning`, `plan-to-tasks` nor `coding` skill required or checked that step. A coding session could therefore start from an undistributed cross-repository plan and create a worktree and an implementation record for work no participating repository had received. The skills also did not distinguish a workspace plan that declares participating child repositories from one that declares only the reserved `workspace` root entry, so a root-only plan risked being forced through a split while a genuine cross-repository plan had no gate. Nothing required the split session to report each repository's slice state, and a participating repository session had no rule for a plan directory that carried no slice manifest.

## Decision

- A workspace plan that declares at least one non-root participating repository must be split by plan-to-tasks before implementation, and completing that split runs `ai-workflow workspace distribute --plan <directory>` after the task triplets, their pair records and `workspace.yaml` are written and the final `ai-workflow plan validate --plan <directory>` passes.
- The split reports each participating repository's slice state and the reserved `workspace` root entry; when distribution refuses on a divergent slice, an unmet repository precondition or an invalid manifest, the split reports the exact errors and the repair instructions, states that the plan is not ready for coding and that the written task artifacts stay in place, and completes the handoff only after a later successful distribution.
- The coding entry confirms the distributed slices with `ai-workflow workspace status --plan <directory>` before any work and refuses an undistributed cross-repository plan before creating a worktree or an implementation record, directing to plan-to-tasks, or to `ai-workflow workspace distribute --plan <directory>` when the split artifacts exist.
- A coding session in a participating repository whose plan directory has no slice `workspace.yaml` stops before creating a worktree or an implementation record, reports the missing manifest for that repository and names `ai-workflow workspace distribute --plan <directory>` as the repair.
- A workspace plan whose `workspace_repos` declares only the reserved `workspace` root entry stays unsplit-capable: it may be implemented like a single-repository plan, with no distribution required or attempted.
- The rule is stated by the shipped `planning`, `plan-to-tasks` and `coding` skills, the project contract in `templates/project/AGENTS.md` and `.ai-workflow/AGENTS.md`, the project memory in `templates/project/MEMORY.md` and `MEMORY.md`, and `README.md`.

## Alternatives considered

- **Distribute from the planning session.** Declined: planning owns only the workspace-root pair and never writes a slice, and distribution needs the split's task triplets, pair records and `workspace.yaml`, so it belongs to the split session after `plan validate` rather than to planning.
- **Distribute only at the coding entry.** Declined: distribution is the split's completion step that hands slices to every participating repository, and leaving it to the coding entry would let repository sessions race to distribute and would blur the split boundary; the coding entry only verifies the slices and refuses when they are absent.
- **Keep the split optional for cross-repository plans.** Declined: an unsplit cross-repository plan has no slices to verify and no repository-level handoff, so leaving the split optional would let an undistributed plan reach implementation, which is the defect this rule prevents.
- **Extend distribution to unsplit plans.** Declined: distribution is defined on a split plan with `workspace.yaml` and a filtered execution order, and an unsplit plan has neither, so extending it would add a second generation path instead of requiring the split.

## Consequences

- Installed host skills and agents are copies, so the rule reaches daily sessions only after the next host install or profile activation; the first cross-repository split after rollout is the runtime observation of the handoff.
- This record scopes the 2026-10-02 delivery: `workspace distribute` keeps verifying each repository read-only and refusing divergence and unmet preconditions before any write, so its distribution behavior is unchanged. The 2026-10-08 [workspace execution consistency record](../bug-fix/2026-10-08-workspace-execution-consistency.md) later added `workspace status` manifest validation, the frozen-order `order` and `next_repository`, and the root `tasks_delivered`/root delivery facts, so this record's earlier claim that `workspace status` behavior was unchanged is partially superseded; the distribution behavior and decision here stay current.
- The refusal paths are explicit: an undistributed cross-repository plan and a missing slice manifest stop before any worktree or implementation record, while a distribution refusal retains the written task artifacts and reports the exact errors and repair, with the handoff completing only after a later successful distribution.
- Root-only and non-workspace plans are unchanged: a root-only workspace plan may be implemented unsplit, and a plan without `workspace_repos` keeps its ordinary single-repository flow.
- No active note is superseded in full. [The submodule workspace delivery record](../architecture/2026-09-30-submodule-workspace.md) keeps its distribution, status and finalization decision and is not moved or archived; the 2026-10-08 [workspace execution consistency record](../bug-fix/2026-10-08-workspace-execution-consistency.md) later updated its `workspace status` and root-delivery current facts, so those facts point there while this record and its boundary decision stay current.
- The next-session routing is stated in more detail by the 2026-10-08 [workspace session handoff record](../bug-fix/2026-10-08-workspace-session-handoff.md), which covers the parent workspace root session, the absolute parent plan directory, the slice-completion handoff and the `ready_for_finalization` finalization step, and partially supersedes this record's generic handoff wording while this record keeps the distribution behavior.
- [The workspace coding orchestration record](../feature/2026-10-09-workspace-coding-orchestration.md) partially supersedes this record's generic handoff wording with the delivered parent orchestration, per-repository worktrees, checkpoint command and bounded recovery; the distribution behavior and decision here stay current.
