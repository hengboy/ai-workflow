# Execution order

`tasks/execution-order.yaml` is the frozen schedule a split plan writes after the task triplets and their pair records. It is the only scheduling authority for a split plan: coding reads it in file order and never recomputes phases from `depends_on`.

## Schedule shape

```yaml
plan_id: 20260925-example
phases:
  - parallel:
      - task-001-first
      - task-002-second
  - parallel:
      - task-003-third
```

`plan_id` is the frozen plan id as a string. `phases` is a non-empty ordered list, and each `- parallel:` entry holds a non-empty list of `task-…` IDs. Every scheduled id exists and appears exactly once across the file.

## Derivation rule

- A task's phase is one greater than the latest phase of its dependencies, and tasks at the same depth form one parallel group.
- The critical path is the longest dependency chain through the graph.
- Every dependency appears in a strictly earlier phase, and no two tasks in one phase have overlapping normalized write-scope paths: a shared path and a directory that contains another task's file both collide, so same-phase write scopes must be disjoint.

Coding keeps Git commits serial: after a phase is verified, each task's write scope is committed through Git Operator one commit at a time.

## Finalization coverage

The schedule stays `task-only`: root finalization coverage is not a task phase, so `finalization` criteria never appear in `phases` and never add phases or parallel tasks. Reserved root-entry tasks are scheduled normally; finalization-only coverage stays outside the task DAG.

## Validation

`ai-workflow plan validate --plan <directory>` validates the schedule whenever the plan directory contains task documents. A missing or invalid order fails validation and blocks the split: report the named defect instead of writing a schedule that does not match the approved preview.

## No bilingual sibling

The schedule has no .zh.md or .i18n.yaml sibling. It is machine-readable like `implementation.yaml`; never create, pair or require a translated counterpart.

## Example

A plan whose three tasks form a single dependency chain produces three one-task phases, while independent tasks with disjoint write scopes collapse into one parallel phase.

## Workspace repositories

For a workspace plan, `workspace.yaml` splits the schedule by repository. Derive the repository phases from the plan's `declared order`: a repository is scheduled after every repository it `depends_on`, and each repository keeps its own `repository's task DAG` for the tasks inside it. The critical path is the longest chain across the repository order and the task DAGs.

Within one repository, same-phase scope comparison uses each task's repository-relative scopes, so equal write-scope paths `inside one repository` still collide and must be `disjoint`. Because scopes are repository-relative, equal repository-relative paths in different repositories are disjoint and may share a phase.

The strictly-after rule holds at repository granularity: every task of a repository is scheduled `strictly after every task of the repositories it depends on`, so a dependent repository never starts in the same phase as any task of its dependencies.

A plan without `workspace_repos` uses the single-repository schedule above unchanged.
