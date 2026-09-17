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

The English `plan.md` mirrors the structure of `plan.zh.md`. The Chinese side has no YAML frontmatter and starts with the same English title followed by the Chinese switcher:

```markdown
# Implementation Plan

[English](plan.md) | 中文

（中文正文，结构镜像英文侧；无 YAML frontmatter。）
```

Only the English `plan.md` carries the YAML frontmatter with `plan_id`, `status: frozen`, counts and `digest: ""`. The Chinese bytes never affect the digest.

## Requirement coverage

| Requirement | Acceptance criteria | Implementation step | Validation |
| --- | --- | --- | --- |
| REQ-001 | AC-001 | Step 1 | Targeted behavior test |

## Implementation sequence

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
