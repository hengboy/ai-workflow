---
plan_id: "{{plan_id}}"
status: frozen
created_at: "{{created_at}}"
supersedes: null
requirement_count: "{{requirement_count}}"
acceptance_criteria_count: "{{acceptance_criteria_count}}"
digest: "{{digest}}"
---

# Specification

Replace every placeholder and illustrative entry below. Remove this instruction before freezing the document.

## Goal

State the user-visible outcome and how success will be measured.

## Non-goals

- Name adjacent behavior that this plan intentionally does not change.

## Scenarios

### Primary scenario

Describe the actor, starting state, action, and observable result.

## Requirements

### REQ-001: Short requirement name

State one testable behavior without prescribing an implementation unless it is mandated.

## Acceptance criteria

### AC-001: Observable result for REQ-001

- Given a defined starting state
- When the actor performs the action
- Then the observable result occurs

## Error boundaries and counterexamples

- Boundary: identify the smallest, largest, empty, or invalid input that matters.
- Counterexample: state an input or state that must not produce the successful result.

## Verification layers and RED criteria

| Requirement | Acceptance criteria | Layer | RED evidence before implementation |
| --- | --- | --- | --- |
| REQ-001 | AC-001 | Behavior test | The test fails because the result is not implemented. |

## Compatibility and rollback

State compatibility expectations and the observable rollback condition.

## Example

For a notification preference feature, a completed entry could read:

```markdown
### REQ-001: Persist email notification preference

An authenticated user can enable or disable email notifications, and the selected value remains effective after a new session.

### AC-001: Disabled preference survives a new session

- Given email notifications are enabled for an authenticated user
- When the user disables them and signs in again
- Then the preference remains disabled and no email notification is queued

- Counterexample: changing browser-local state without a successful server response must not change the stored preference.
```
