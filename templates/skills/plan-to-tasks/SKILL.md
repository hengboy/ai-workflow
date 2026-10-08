---
name: plan-to-tasks
description: Preview and freeze executable task files from a confirmed plan.
---

# Plan to tasks

## Outcome

Convert one frozen spec/plan pair into an approved, immutable task DAG that coding can execute. This skill only previews and writes task documents; it does not generate or run a workflow. A workspace split also completes when the split session hands each participating repository its slice.

## Preconditions

- `spec.md` and `plan.md` exist in the same plan directory.
- Both have `status: frozen`, matching `plan_id`, counts and valid digests.
- Validate the pair with `ai-workflow plan validate --plan <directory>`; use the frozen-plan digest protocol from the planning skill as the source of truth.
- The plan identifies role responsibility, validation and bounded implementation scope.

Stop and report the exact defect if any precondition fails. Never repair or rewrite frozen inputs.

## Navigation-first context

Directly read `.ai-workflow/AGENTS.md`, `MEMORY.md`, `.ai-workflow/index/navigation.json` and `.ai-workflow/index/navigation.md`, then resolve known affected features through `ai-workflow context locate --project <absolute-project-root> --feature <id> --verify`. The project contract applies to the whole project and to every participating agent. `<absolute-project-root>` is the normalized project directory path, never its directory name. Use that locator's exact `read_order` paths directly to build each task's `read_scope`: fixed context plus exactly those exact paths. Do not search; `read_scope` must not use `src/`, `tests/` or the project root. When the locator returns `missing_index`, `miss`, `stale` or `invalid`, request File Explorer with authorized module roots and use only its returned exact paths.

Route note format, lifecycle, supersession and archive governance through `.ai-workflow/notes/README.md`, reached via `.ai-workflow/notes/AGENTS.md`; do not copy those rules into task files. Add only the relevant notes and governance files to a task's bounded read/write scope, as exact paths, and never require a task to read the entire notes history.

## Decomposition rules

- Prefer independently testable vertical outcomes over file-by-file chores.
- Split only where relatedness, priority or dependency justifies it; order dependent and higher-priority work before the rest.
- Never over-decompose: every task adds a delegation, a verification and a commit, so merge changes that share one outcome, one surface and one validation command into one task.
- Assign sequential IDs: `task-001-short-slug`, `task-002-short-slug`.
- Map every REQ and AC to at least one task; explain intentional shared coverage.
- Declare dependencies only for data, contract, ordering or overlapping-write constraints.
- Use `surface: backend|frontend|cross-stack|test|docs|research|documentation` to route implementation; `research` delegates every technology, project, concept, topic or keyword research request to Researcher, whether or not links are supplied, and `documentation` to Documentation Maintainer for non-code documentation and index maintenance.
- Every generated task must include a non-empty, supported `surface`; a plan's `Responsible role` is converted to that task surface during decomposition.
- Make read scopes bounded and write scopes exact enough for filesystem enforcement.
- Ask File Explorer for exact paths when an entry, call chain or dependency is unknown.
- Never use `.`, project root, `**`, an unresolved placeholder or a broad directory with unclear ownership as write scope.
- Never use `src/`, `tests/` or the project root as read scope; read scope is the fixed context (`.ai-workflow/AGENTS.md`, `MEMORY.md`, both navigation files) plus exact locator paths.
- Add only the relevant notes and note-governance files to a task's bounded read/write scope as exact paths; do not include the entire notes history.
- A task landing a non-mechanical decision includes its note update, lifecycle transition and the `ai-workflow notes validate` check; purely mechanical tasks are exempt.
- Force tasks with overlapping write scopes into dependency order.
- Put frontend and backend validation commands on their responsible tasks; add an integration task only when cross-stack behavior requires it.

## Coverage and DAG checks

Before previewing, verify:

- no missing or unknown REQ/AC identifiers;
- no duplicate task IDs;
- every dependency refers to a proposed task;
- the graph is acyclic;
- no parallel tasks have overlapping or unknown write scopes;
- each task can produce one coherent Git commit;
- tests prove its assigned acceptance criteria;
- screenshot-producing tests name the plan's `screenshot/` directory.

The frozen-plan digest protocol is shared with planning and coding: `ai-workflow plan validate --plan <directory>` must pass before previewing tasks.

## Approval preview

Show the entire task set in one response, including:

- task ID, objective and surface;
- covered REQ/AC;
- dependencies and why they exist;
- read/write scopes;
- test commands and expected evidence;
- parallel phases, the critical path, parallel groups and risks;
- a coverage matrix for all REQ/AC;
- for a workspace split, that completing the split writes a slice into each participating repository through `ai-workflow workspace distribute --plan <directory>`.

Ask for explicit approval. Before approval, do not create `tasks/` or write partial task files. Any material edit requires a fresh complete preview.

## Task file contract

After approval, atomically add each task as a complete bilingual triplet under `tasks/`: the English main document `tasks/task-NNN-slug.md`, the Chinese prose side `tasks/task-NNN-slug.zh.md`, and the `tasks/task-NNN-slug.i18n.yaml` consistency record. Only `tasks/task-NNN-slug.md` is the task used for enumeration, routing and dependency checks; `.zh.md` and `.i18n.yaml` are its companions and must never be enumerated as tasks.

Frontmatter lives only on the English `task-NNN-slug.md` side and must contain exactly usable values for:

- `id`;
- `requirements`;
- `acceptance_criteria`;
- `depends_on`;
- `repo` (required for a workspace plan);
- `surface`;
- `read_scope`;
- `write_scope`;
- `test_commands`.

The Chinese `.zh.md` side has no frontmatter and starts with `# Task`; both sides use the switchers `English | [中文](task-NNN-slug.zh.md)` and `[English](task-NNN-slug.md) | 中文`, and mirror headings, structure, tables, lists and link targets, differing only in prose.

Confirm the parent plan passes with `ai-workflow plan validate --plan <directory>` before creating tasks. Write both language sides of every task first, record each pair with `ai-workflow plan pairing --plan <directory> --write --all`, then write the schedule. Write `tasks/execution-order.yaml` after writing and recording every task triplet, and before the final `ai-workflow plan validate --plan <directory>`. The written `tasks/execution-order.yaml` matches the approved preview.

Read [the task template](references/task.md) before drafting. Preserve its frontmatter and body contract while replacing the illustrative example with the approved task's actual scope and evidence.

The body states the outcome, implementation notes justified by the plan, negative cases, test evidence and completion definition. Do not modify `spec.md` or `plan.md`.

After writing, re-read every task file and `tasks/execution-order.yaml`, then repeat the coverage, dependency, acyclicity and write-scope checks against the frozen spec/plan.

Task files live under the plan's gitignored `.ai-workflow/` directory. Plan-to-tasks creates no Git commit: do not dispatch Git Operator and do not stage or commit the task files. Leave them as local, untracked files.

## Execution order

Derive the task graph's phases from `depends_on`: a task's phase is one greater than the latest phase of its dependencies, and tasks at the same depth form one parallel group. The critical path is the longest dependency chain through the graph.

Read [the execution-order reference](references/execution-order.md) for the exact schedule shape before computing phases. `tasks/execution-order.yaml` is an ordered list of non-empty parallel phases that covers every task exactly once; `ai-workflow plan validate --plan <directory>` reports the phases and fails on a missing or invalid order.

The schedule has no .zh.md or .i18n.yaml sibling. It is a machine-readable local artifact like `implementation.yaml`; never pair it with a translated side.

## Workspace split

A plan whose frozen `plan.md` declares `workspace_repos` is a workspace plan. Split it with the workspace rules below; a plan without `workspace_repos` keeps the single-repository flow above `unchanged`.

Assign `repo` to every task: each task's `repo` is one declared repository name, required exactly for a workspace plan and forbidden otherwise. Task read and write scopes are repository-relative; never mix repositories in one task.

plan-to-tasks `derives each repository's phases from the declared order` while keeping the `repository-internal task DAG`: `depends_on` only ever names a task in the same repository, and each repository's `repository phases` come from the `workspace_repos` dependency order. Preview the repository phases with the `critical path` in the approval preview, showing each repository's phase list and the ordered delivery sequence.

Write `workspace.yaml` after the task triplets and their pair records and before the final `ai-workflow plan validate --plan <directory>`. The manifest carries `plan_id`, `role: workspace`, and one `repositories` entry per declared repository, including the `reserved` `workspace` `root entry` and `its tasks`. A repository entry carries `name`, `path`, `depends_on`, `requirements` and `acceptance_criteria`; the reserved root entry carries the tasks assigned to the workspace root itself.

After `workspace.yaml` is written and the final `ai-workflow plan validate --plan <directory>` passes, the split runs `ai-workflow workspace distribute --plan <directory>` with the same absolute parent workspace plan directory. On success it reports, in the approved `workspace_repos` delivery order including the root tasks, each participating repository's name, path and slice state (`written` or `unchanged`), the validation and distribution result, and the reserved root entry, whose state is the workspace-root rather than written or unchanged because its tasks stay in the root plan. It then runs `ai-workflow workspace status --plan <directory>` against the parent workspace plan directory, never a slice. Report the frozen delivery phases from `tasks/execution-order.yaml` and each repository's `depends_on`, and treat `workspace status`'s child-only `next_repository` as advisory that cannot override the frozen schedule or root-owned tasks; root-owned tasks keep their place and can precede dependent children.

The handoff gives the next Coding session the working directory `<repository-root>` (the workspace root when the next frozen task is root-owned, otherwise `<workspace-root>/<repo-path>`) and the local frozen plan directory `<repository-plan-directory>` (the original parent `<workspace-plan-directory>` for a root-owned task, otherwise `<workspace-root>/<repo-path>/.ai-workflow/plans/<planId>`). Before showing the prompt, replace every placeholder with the actual absolute root, repository name and plan ID/directory, quote any path argument that contains spaces (including in the command), and write the prompt in the user's language; for a child repository require its slice `present`; for the workspace root verify the root-owned tasks in the parent plan (the root keeps its tasks there and has no slice). The copyable next Coding prompt is:

```text
Start a new session at <repository-root> and invoke the coding skill. Implement only this repository's tasks from the local frozen plan <repository-plan-directory> in the approved order. Before implementation, run ai-workflow workspace status --plan <workspace-plan-directory> against the original parent workspace plan directory, confirm the current repository's delivery position, and require slice present only for a child repository (the workspace root keeps its tasks in the parent plan).
```

When distribution refuses, report the exact error and the repair instructions, state that the plan is not ready for coding and the written task artifacts stay in place, and rerun `ai-workflow workspace distribute --plan <directory>` with the same absolute parent plan only after the repair; complete the handoff only after a later successful distribution. A workspace plan whose `workspace_repos` declares only the reserved workspace root entry may be implemented unsplit.

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

## Completion checklist

- The user approved the complete preview.
- All files match the approved graph.
- Coverage is complete and the DAG is valid.
- Frozen spec/plan bytes are unchanged.
- `tasks/execution-order.yaml` is written for every split plan and `ai-workflow plan validate --plan <directory>` passes.
- No Git commit was created for the task files; they remain gitignored local artifacts under `.ai-workflow/plans/<planId>/tasks/`.
- No workflow or run was started.
- A workspace split reports the completion handoff: each participating repository's name, path and slice state, the `ai-workflow workspace status --plan <directory>` result and the frozen delivery order, plus the next Coding directory and copyable prompt naming the frozen plan directory.
