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

Replace every placeholder and illustrative entry below. Remove this instruction before freezing the document.

## Requirement coverage

| Requirement | Acceptance criteria | Implementation step | Validation |
| --- | --- | --- | --- |
| REQ-001 | AC-001 | Step 1 | Targeted behavior test |

## Implementation sequence

### Step 1: Short outcome name

- Responsible role: `backend`, `frontend`, `test`, or another installed native role.
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
