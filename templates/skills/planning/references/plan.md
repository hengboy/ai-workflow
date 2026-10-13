---
plan_id: "{{plan_id}}"
status: frozen
created_at: "{{created_at}}"
supersedes: null
requirement_count: "{{requirement_count}}"
acceptance_criteria_count: "{{acceptance_criteria_count}}"
digest: ""
---

# Implementation Plan

English | [中文](plan.zh.md)

Replace every placeholder and illustrative entry below. Remove this instruction before freezing the document.

## Bilingual shape

Apply Planning's [Document contract](../SKILL.md#document-contract). The Chinese `plan.zh.md` starts as follows, with no YAML frontmatter:

```markdown
# Implementation Plan

[English](plan.md) | 中文

（中文正文，结构镜像英文侧；无 YAML frontmatter。）
```

## Requirement coverage

| Requirement | Acceptance criteria | Implementation step | Validation |
| --- | --- | --- | --- |
| REQ-001 | AC-001 | Step 1 | Targeted behavior test |

## Implementation sequence

Keep the sequence cohesive and priority-ordered: merge tightly related behavior and its tests into one step, and do not create per-file or mechanical steps that only add execution overhead.

### Step 1: Short outcome name

- Responsible role: `backend`, `frontend`, `test`, or another installed native role. Do not add a `surface` field to a plan step; surface routing belongs to generated task files.
- Read scope: exact files or bounded directories needed for context.
- Write scope: exact files the step may change.
- Changes: describe the intended behavior and important constraints.
- Validation: list commands and the evidence each command must produce.
- Dependencies: name preceding steps or state `none`.

## Integration and compatibility

Describe cross-component contracts, migration needs, backwards compatibility, and rollout order.

## Rollback

Describe what is reverted, what data remains valid, and how recovery is verified.

## Risks

| Risk | Mitigation | Evidence |
| --- | --- | --- |
| State one concrete risk. | State the bounded mitigation. | Name the validating check. |

## Example

For the notification preference requirement in `spec.md`, a completed step could read:

```markdown
### Step 1: Persist notification preferences

- Responsible role: `backend`
- Read scope: `src/preferences/`, `tests/preferences/`
- Write scope: `src/preferences/store.ts`, `tests/preferences/store.test.ts`
- Changes: store the authenticated user's email preference through the existing preferences repository and preserve the current default for records without a value.
- Validation: `pnpm vitest run tests/preferences/store.test.ts` proves AC-001 and the missing-value compatibility case.
- Dependencies: none
```

## Workspace repositories

When the plan targets a workspace root, the frozen frontmatter additionally declares `workspace_repos`: the participating repositories and their dependency order. Each entry carries a repository `name` — the `.gitmodules` submodule `section name` that distribution verifies — a repository-relative `path` and a `depends_on` list naming the participants that must be delivered first. The declaration must contain exactly one `reserved` `root entry` named `workspace` with `path: .` and an empty `depends_on`.

```yaml
workspace_repos:
  - name: workspace
    path: .
    depends_on: []
  - name: lib-core
    path: vendor/lib-core
    depends_on: [workspace]
  - name: app-web
    path: apps/app-web
    depends_on: [workspace, lib-core]
```

State the `per-repository delivery boundary` here as well: every task belongs to exactly one repository, task read and write scopes are repository-relative, no task depends on a task in another repository, and every task of a repository is delivered strictly after every task of the repositories it depends on. A plan without `workspace_repos` has no repositories and keeps the single-repository contract unchanged.

Distinguish root-owned task delivery (the prefix for children depending on `workspace`) from later pointer finalization; the reserved root still has empty `depends_on`. The same root implementation record stays in-progress with `root_tasks_commit` after delivery and becomes completed only after finalization. Require exact schedule coverage, strictly earlier task and repository dependencies, and disjoint same-repository parallel write scopes; root sessions filter phases in memory without changing file order or recomputing the DAG.

For required cross-repository acceptance evidence, name the responsible owner, exact authorized commands and expected evidence. Finalization requires validated parent workspace status, present completed children with full SHAs, `ready_for_finalization` and root `tasks_delivered` true. Explicitly authorize read-only workspace/source checks and whole-batch delivery-commit existence verification before pinning; no sibling writes, automatic checkout changes or publishing are authorized.

## Workspace finalization

A plan with participating non-root repositories may declare optional `workspace_finalization` frozen root coverage in the frontmatter: `requirements`, `acceptance_criteria`, repository-qualified `read_scope` entries, root-relative `write_scope` and ordered `test_commands`. Finalization acceptance criteria are `disjoint` from every task's acceptance criteria; requirements may overlap task requirements. This root-owned coverage `never becomes a task`, `never joins the execution order` and is `not sliced` into any repository. Complete coverage is the `union` of task and finalization coverage: the manifest's root subset is root task plus finalization coverage; child subsets remain exactly their tasks. Commands run in the finalization worktree; root write scope cannot enter a submodule, change the repository boundary or claim sibling files. Without this field, coverage logic is unchanged. Never infer frozen criteria from prose or migrate them; reject tasks claiming finalization-only criteria.
