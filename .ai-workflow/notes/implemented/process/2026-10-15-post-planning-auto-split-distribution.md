# Agent Note: Post-planning automatic split distribution

Status: implemented

English | [中文](2026-10-15-post-planning-auto-split-distribution.zh.md)

## Problem

A child-participating workspace plan could not reach implementation without an extra manual step. After Planning froze `spec.md` and `plan.md`, the planning session stopped at the frozen plan and told the user to start a new session at the workspace root, but nothing invoked plan-to-tasks, validated the split, distributed the slices or declared the task set frozen. A user could therefore receive a frozen plan with no executable task set, and the coding session would only then run the preparation or refuse an undistributed plan. The requested behavior was one automatic chain after planning that ends with a frozen, distributed task set.

## Decision

- Immediately after the frozen pair passes `ai-workflow plan validate --plan <directory>`, the planning session for a plan whose `plan.md` declares `workspace_repos` with at least one participating non-root repository automatically invokes the plan-to-tasks preparation procedure in the same session with the absolute parent plan directory; it starts no additional session, sibling process or provider API.
- The chained procedure shows the complete approval preview and requests explicit approval before writing any task artifact, schedule, `workspace.yaml` or slice, and a declined approval creates no tasks, slices, distribution or implementation prompt.
- After approval it writes the complete task triplets and their pair records, `tasks/execution-order.yaml` and `workspace.yaml`, passes the final `ai-workflow plan validate --plan <directory>`, runs `ai-workflow workspace distribute --plan <directory>` for every participating repository, and requires `ai-workflow workspace status --plan <directory>` to report valid with every participating slice present.
- The executable task set becomes frozen only after that full distribution succeeded for every participating repository; until then the split states that the task set is not frozen, declares no completion and starts no implementation state, and a refusal or incomplete distribution keeps the written artifacts in place, is repaired and re-recorded with `ai-workflow plan pairing --plan <directory> --write --all`, revalidated with `ai-workflow plan validate --plan <directory>` and rerun, never regenerated.
- After the freeze the session reports each participating repository's name, path, `depends_on` and slice state and the frozen delivery order, then tells the user to start a new session at the workspace root that invokes the coding skill with the absolute frozen plan directory to implement the frozen plan; the coding session verifies the delivery gate before any worktree or implementation record and implements without repeating the split or distribution.
- Ordinary plans, root-only workspace plans whose `workspace_repos` declares only the reserved `workspace` root entry, and projects without `.gitmodules` keep their current routes, and the standalone plan-to-tasks invocation plus the coding session's bounded recovery preparation for a plan with no task set or incomplete slices remain.

## Alternatives considered

- **Keep the split in a new coding session.** Declined: it leaves the required automatic chaining after planning unimplemented and still asks the user to start a separate session before the task set exists.
- **Move the spec/plan freeze after distribution.** Declined: it inverts the frozen-input dependency, because distribution consumes the frozen pair, and it diverges the slice bytes from the distributed plan.

## Consequences

- The rule is prompt guidance shipped in `templates/skills/planning/SKILL.md`, `templates/skills/plan-to-tasks/SKILL.md`, `templates/skills/coding/SKILL.md` and `templates/skills/coding/references/workspace.md`, `templates/project/AGENTS.md` and `.ai-workflow/AGENTS.md`, `README.md`, root `MEMORY.md` and the authoritative navigation, so no schema, configuration, status or data migration is introduced.
- Focused shipped-content tests in `tests/behavior/workspace-planning-content.test.ts`, `tests/behavior/change-routing.test.ts` and `tests/behavior/workspace-workflow-content.test.ts` lock the chained flow, the freeze gate and the unchanged ordinary, root-only and non-`.gitmodules` routes; they prove shipped prompt guidance, not host runtime enforcement.
- An earlier planning boundary that would have frozen the task set only after distribution is superseded and deleted before this delivery, and its accepted freeze-gate semantics merge into this record.
- This record partially supersedes the handoff facts in [the Planning and coding session boundary record](./2026-09-23-planning-coding-session-boundary.md), [the workspace split distribution handoff record](./2026-10-02-workspace-distribute-handoff.md), [the workspace session handoff record](../bug-fix/2026-10-08-workspace-session-handoff.md) and [the workspace coding orchestration record](../feature/2026-10-09-workspace-coding-orchestration.md); each keeps its decision, rationale and evidence limits, and its current handoff fact points here.
