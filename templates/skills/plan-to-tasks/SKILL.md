---
name: plan-to-tasks
description: Preview and freeze executable task files from a confirmed plan.
---

# Plan to tasks

## Outcome

Convert one frozen spec/plan pair into an approved, immutable task DAG that coding can execute. This skill only previews and writes task documents; it does not generate or run a workflow. A workspace split also completes when the split session hands each participating repository its slice, per the freeze gate in `## Workspace split`.

## Invocation modes

This skill supports two invocation modes over the same preview, validation and write procedure:

- A `standalone` invocation is a user-started plan-to-tasks session. It ends after its handoff: the completion report and the copyable next-Coding prompt below are its final output, and it starts no Coding work.
- A `preparation procedure` invocation runs inside an already-running session over a frozen child-participating workspace plan with no task set. The `planning session` automatically invokes it `immediately after` a child-participating workspace plan freezes and its frozen pair passes `plan validate`, and the `parent Coding session` invokes it as its bounded recovery path when a frozen plan has no task set or incomplete slices. After the full `approval preview`, approval, writing, validation and distribution below, it `returns control` to the `same parent Coding session` (or the chaining planning session) for implementation.

Declining the approval creates no tasks, no slices, no worktrees and no implementation records; a declined `approval preview` reports only managed synchronization changes, and those are reported separately. Valid existing split artifacts are reused `byte-unchanged`. A `partial` or invalid task set and a `divergent` slice stop with a `repair request`; never `regenerate` them.

## Preconditions

- `spec.md` and `plan.md` exist in the same plan directory.
- Both have `status: frozen`, matching `plan_id`, counts and valid digests.
- Before previewing tasks, validate the input pair with `ai-workflow plan validate --plan <directory>`; the planning skill's frozen-plan digest protocol is the source of truth.
- The plan identifies role responsibility, validation and bounded implementation scope.

Stop and report the exact defect if any precondition fails. Never repair or rewrite frozen inputs.

## Navigation-first context

Directly read the fixed context: `.ai-workflow/AGENTS.md`, `MEMORY.md`, `.ai-workflow/index/navigation.json` and `.ai-workflow/index/navigation.md`. The contract governs the whole project and every participating agent.

Resolve known affected features through `ai-workflow context locate --project <absolute-project-root> --feature <id> --verify`; the root argument is the normalized project directory path, never its directory name. Build each task's `read_scope` from fixed context plus the locator's exact `read_order` paths. Do not search; `read_scope` must not use `src/`, `tests/` or the project root. For `missing_index`, `miss`, `stale` or `invalid`, request File Explorer with authorized module roots and use only its returned exact paths.

Route note format, lifecycle, supersession and archive governance through `.ai-workflow/notes/README.md`, reached via `.ai-workflow/notes/AGENTS.md`; do not copy those rules into task files. Add only the relevant notes and governance files to a task's bounded read/write scope, as exact paths, and never require a task to read the entire notes history.

## Work-boundary synchronization

At skill session start, invoke exactly once for the actual project root: `ai-workflow sync-hook --host <current-host> --phase --project <actual-root>`.
Follow `decision`, not the exit code (0 even on denial): `deny` or a `conflict`/`failed` `report.status` stops the split; warnings proceed without a freshness claim; `skip` means no adoption.
Later steps, split phases and native host events reuse that root's stored result with no source request; a missing, corrupt or unreadable check allows with visible no-freshness context.
After a safe patch changes the contract or owned workflow rules, read `.ai-workflow/AGENTS.md` again before ordinary work; frozen spec/plan/task bytes are immutable and never synchronization input, and contradictory authority stops the split with a bounded support request.

## Decomposition rules

Before drafting, read [the task template](references/task.md) for the full field, bilingual and body contract; preserve it while replacing examples with approved scope and evidence. Read [the execution-order reference](references/execution-order.md) before computing phases or previewing the graph; it owns depth, critical-path and scope-conflict rules for both ordinary and workspace schedules.

- Prefer independently testable vertical outcomes over file-by-file chores.
- Split only where relatedness, priority or dependency justifies it; order dependent and higher-priority work before the rest.
- Never over-decompose: every task adds a delegation, a verification and a commit, so merge changes that share one outcome, one surface and one validation command into one task.
- Map every REQ and AC to task coverage or separately declared workspace finalization coverage; explain intentional shared coverage.
- Declare dependencies only for data, contract, ordering or overlapping-write constraints.
- Ask File Explorer for exact paths when an entry, call chain or dependency is unknown.
- A task landing a lasting decision whose rationale code, tests and existing documentation cannot adequately explain includes its note update, lifecycle transition and the `ai-workflow notes validate` check; local, mechanical, UI, copy and formatting changes without such lasting rationale are exempt.

## Coverage and DAG checks

Before previewing, verify complete coverage with no unknown REQ/AC or duplicate task IDs, dependencies naming proposed tasks, an acyclic graph and no parallel overlapping or unknown write scopes. Each task must produce one coherent Git commit with tests proving its AC; screenshot-producing tests name the plan's `screenshot/` directory. Apply the mandatory execution-order reference to the complete graph. Plan-to-tasks dispatches neither review axis: it starts no Spec Review, no Standards Review and no per-task review trigger.

## Approval preview

Show the entire task set in one response, including:

- task ID, objective and surface;
- covered REQ/AC;
- dependencies and why they exist;
- read/write scopes;
- test commands and expected evidence;
- parallel phases, the critical path, parallel groups and risks;
- a coverage matrix for all REQ/AC;
- for a workspace split, each repository's phase list and ordered delivery sequence;
- for a workspace split, that completing the split writes a slice into each participating repository through `ai-workflow workspace distribute --plan <directory>`.

Ask for explicit approval. Before approval, do not create `tasks/` or write partial task files. Any material edit requires a fresh complete preview.

## Task file contract

After approval, follow the mandatory task template and this write order:

1. Atomically add each complete bilingual task triplet under `tasks/`: `task-NNN-slug.md`, `task-NNN-slug.zh.md` and `task-NNN-slug.i18n.yaml`. Write both language sides first, then record their pairs with `ai-workflow plan pairing --plan <directory> --write --all`.
2. Write `tasks/execution-order.yaml` and, for a workspace, `workspace.yaml` after the task triplets and their pair records, before the final `ai-workflow plan validate --plan <directory>`. Each written artifact matches the approved preview; the schedule has no .zh.md or .i18n.yaml sibling.
3. After writing, re-read every task file, `tasks/execution-order.yaml` and any workspace manifest; repeat coverage, dependency, acyclicity and write-scope checks against the frozen spec/plan.
4. Run the final `ai-workflow plan validate --plan <directory>` over the written artifacts. Missing or invalid execution order blocks completion. Only after it passes, complete any workspace distribution below.
5. A child-participating workspace task set is not frozen by that validation alone: it becomes frozen only after the distribution below succeeds for every participating repository with `ai-workflow workspace status --plan <directory>` valid and every participating slice present. Until then repair the cause, re-record changed task artifacts with `ai-workflow plan pairing --plan <directory> --write --all`, revalidate with `ai-workflow plan validate --plan <directory>` and rerun the distribution; never regenerate the task set.

Never modify frozen `spec.md` or `plan.md`; task files are immutable once the task set is frozen, and a changed task after the freeze requires a new version. They remain local, untracked artifacts in the plan's gitignored `.ai-workflow/` directory. Plan-to-tasks creates no Git commit: do not dispatch Git Operator and do not stage or commit task files.

## Workspace split

A plan whose frozen `plan.md` declares `workspace_repos` is a workspace plan. Split it with the workspace rules below; a plan without `workspace_repos` keeps the single-repository flow above `unchanged`.

Assign `repo` to every task under the task template's repository contract. Derive repository phases and the critical path through the execution-order reference's declared-order rules and repository-internal task DAG.

Write `workspace.yaml` at the Task file contract's manifest step. It carries `plan_id`, `role: workspace`, and one `repositories` entry per declared repository, including the `reserved` `workspace` `root entry` and `its tasks`. Each entry carries `name`, `path`, `depends_on`, `requirements` and `acceptance_criteria`. Child coverage equals its tasks; root coverage includes its tasks plus any declared finalization coverage.

```yaml
plan_id: 20260925-example
role: workspace
repositories:
  - name: workspace
    path: .
    depends_on: []
    requirements: [REQ-001]
    acceptance_criteria: [AC-001]
  - name: lib-core
    path: vendor/lib-core
    depends_on: [workspace]
    requirements: [REQ-002]
    acceptance_criteria: [AC-002]
  - name: app-web
    path: apps/app-web
    depends_on: [workspace, lib-core]
    requirements: [REQ-003]
    acceptance_criteria: [AC-003]
```

After `workspace.yaml` is written and the final `ai-workflow plan validate --plan <directory>` passes, the split runs `ai-workflow workspace distribute --plan <directory>` with the same absolute parent workspace plan directory. On success it runs `ai-workflow workspace status --plan <directory>` against the parent workspace plan directory, never a slice, and requires `valid: true`. Successful full distribution with every participating slice `present` and that valid `workspace status` are the freeze gate: the task set becomes frozen only after that distribution succeeded for every participating repository, and an incomplete distribution leaves the task set not frozen. It reports, in the validated frozen delivery order, each participating repository's name, path and slice state (`written` or `unchanged`), the validation and distribution result, and the reserved root entry, whose state is the workspace-root rather than written or unchanged because its tasks stay in the root plan. Report the frozen delivery phases from `tasks/execution-order.yaml` and each repository's `depends_on`. Use the report's root-inclusive `next_repository`: order follows each task's repository's first appearance in the frozen schedule, with declared zero-task repositories appended, not the manifest array. Pending root-owned tasks participate through `workspace_root_entry.tasks_delivered`; zero root tasks are implicitly delivered.

The next Coding directory and prompt below apply only to `standalone`; preparation returns to its parent as defined in Invocation modes. Use `next_repository` to select `<repository-root>` (workspace root for pending root-owned tasks, otherwise `<workspace-root>/<repo-path>`) and local frozen plan directory `<repository-plan-directory>` (original parent `<workspace-plan-directory>` for root tasks, otherwise `<workspace-root>/<repo-path>/.ai-workflow/plans/<planId>`). Replace every placeholder with the actual absolute root, repository name and plan ID/directory; quote path arguments containing spaces, including in commands, and use the user's language.

Before any worktree or record, require the current repository to equal `next_repository` and its absolute root to match the reported path. A child requires its slice `present`; the root verifies pending root-owned tasks in the parent plan and has no slice. Invalid status or missing/divergent slices stop the handoff. The copyable next Coding prompt is:

```text
Start a new session at <repository-root> and invoke the coding skill. Implement only this repository's tasks from the local frozen plan <repository-plan-directory> in the frozen order. Before any worktree or record, run ai-workflow workspace status --plan <workspace-plan-directory> against the original parent workspace plan directory, require valid true, the current repository equal to next_repository and the correct absolute repository path, and require every child slice present (the workspace root keeps its pending tasks in the parent plan).
```

When `next_repository` is null, hand off root finalization only if `ready_for_finalization` and `workspace_root_entry.tasks_delivered` are true with child slices `present`, records `completed`, matching `plan_id` and full delivery SHAs. That root session executes zero tasks, skips delivered root tasks and siblings, and preserves the same record's `root_tasks_commit` and `started_at`. Git Operator verifies commit existence in each source repository with `git cat-file -e <sha>^{commit}` for the entire authorized batch before any index mutation, then pins through `git update-index --cacheinfo 160000,<sha>,<path>`; this does not establish reachability from refs, move child checkouts or authorize publishing. A completed root finalization is verified and reported idempotently, not recreated.

When distribution refuses, report the exact error and the repair instructions, state that the plan is not ready for coding and the written task artifacts stay in place, state that the task set stays not frozen, and repair the cause before rerunning: re-record changed task artifacts with `ai-workflow plan pairing --plan <directory> --write --all`, revalidate with `ai-workflow plan validate --plan <directory>`, then rerun `ai-workflow workspace distribute --plan <directory>` with the same absolute parent plan; never regenerate the task set, and complete the handoff only after a later successful distribution. A workspace plan whose `workspace_repos` declares only the reserved workspace root entry may be implemented unsplit.

## Completion checklist

- The user approved the complete preview.
- All files match the approved graph, with complete coverage and a valid DAG.
- Frozen spec/plan bytes are unchanged.
- `tasks/execution-order.yaml` is written for every split plan and `ai-workflow plan validate --plan <directory>` passes.
- Task files remain gitignored and uncommitted; no workflow or run was started.
- A workspace split completed distribution and the report/handoff above; its task set is frozen only after that full distribution succeeded for every participating repository with `ai-workflow workspace status --plan <directory>` valid and every participating slice present. Finish according to Invocation modes.
