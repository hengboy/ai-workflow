---
name: plan-to-tasks
description: Preview, freeze and automatically commit executable task files from a confirmed plan through Git Operator.
---

# Plan to tasks

## Outcome

Convert one frozen spec/plan pair into an approved, immutable task DAG that coding can execute. This skill only previews and writes task documents; it does not generate or run a workflow.

## Preconditions

- `spec.md` and `plan.md` exist in the same plan directory.
- Both have `status: frozen`, matching `plan_id`, counts and valid digests.
- Validate the pair with `ai-workflow plan validate --plan <directory>`; use the frozen-plan digest protocol from the planning skill as the source of truth.
- The plan identifies role responsibility, validation and bounded implementation scope.

Stop and report the exact defect if any precondition fails. Never repair or rewrite frozen inputs.

## Navigation-first context

Directly read `MEMORY.md`, `.ai-workflow/index/navigation.json` and `.ai-workflow/index/navigation.md`, then resolve known affected features through `ai-workflow context locate --project <project> --feature <id> --verify`. Construct each task `read_scope` from fixed context plus the exact locator `read_order`. Do not search; `read_scope` must not use `src/`, `tests/` or the project root. When the locator returns `missing_index`, `miss`, `stale` or `invalid`, request File Explorer with authorized module roots and use only its returned exact paths.

## Decomposition rules

- Prefer independently testable vertical outcomes over file-by-file chores.
- Assign sequential IDs: `task-001-short-slug`, `task-002-short-slug`.
- Map every REQ and AC to at least one task; explain intentional shared coverage.
- Declare dependencies only for data, contract, ordering or overlapping-write constraints.
- Use `surface: backend|frontend|cross-stack|test|docs` to route implementation.
- Make read scopes bounded and write scopes exact enough for filesystem enforcement.
- Ask File Explorer for exact paths when an entry, call chain or dependency is unknown.
- Never use `.`, project root, `**`, an unresolved placeholder or a broad directory with unclear ownership as write scope.
- Never use `src/`, `tests/` or the project root as read scope; read scope is fixed context plus exact locator paths.
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
- critical path, parallel groups and risks;
- a coverage matrix for all REQ/AC.

Ask for explicit approval. Before approval, do not create `tasks/` or write partial task files. Any material edit requires a fresh complete preview.

## Task file contract

After approval, atomically add `tasks/task-001-short-slug.md` files. Frontmatter must contain exactly usable values for:

- `id`;
- `requirements`;
- `acceptance_criteria`;
- `depends_on`;
- `surface`;
- `read_scope`;
- `write_scope`;
- `test_commands`.

Read [the task template](references/task.md) before drafting. Preserve its frontmatter and body contract while replacing the illustrative example with the approved task's actual scope and evidence.

The body states the outcome, implementation notes justified by the plan, negative cases, test evidence and completion definition. Do not modify `spec.md` or `plan.md`.

After writing, re-read every task file and repeat the coverage, dependency, acyclicity and scope checks against the frozen spec/plan. Then delegate Git Operator to create one automatic local commit containing exactly the newly created task files. Provide the approved task graph, exact task-file paths and completed validation evidence; Git Operator must use `$git-message` before committing.

The automatic local commit is part of successful task generation and does not require a second confirmation. If Git Operator cannot isolate the task files, cannot generate a valid message, or cannot create the commit, stop and report the evidence. Do not stage, commit, or repair Git state from the plan-to-tasks role.

## Completion checklist

- The user approved the complete preview.
- All files match the approved graph.
- Coverage is complete and the DAG is valid.
- Frozen spec/plan bytes are unchanged.
- Git Operator created one automatic local commit containing exactly the task files, using a message generated by `$git-message`, and returned its SHA.
- No workflow or run was started.
