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
- Every dependency appears in a strictly earlier phase, and no two tasks in one phase share a normalized write-scope path.

## Validation

`ai-workflow plan validate --plan <directory>` validates the schedule whenever the plan directory contains task documents. A missing or invalid order fails validation and blocks the split: report the named defect instead of writing a schedule that does not match the approved preview.

## No bilingual sibling

The schedule has no .zh.md or .i18n.yaml sibling. It is machine-readable like `implementation.yaml`; never create, pair or require a translated counterpart.

## Example

A plan whose three tasks form a single dependency chain produces three one-task phases, while independent tasks with disjoint write scopes collapse into one parallel phase.
