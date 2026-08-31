---
id: "{{task_id}}"
requirements: ["REQ-001"]
acceptance_criteria: ["AC-001"]
depends_on: []
surface: backend
read_scope: ["{{bounded/read/path}}"]
write_scope: ["{{exact/write/file}}"]
test_commands: ["{{targeted_test_command}}"]
---

# Task

## Objective

State one coherent, independently testable outcome that can be delivered in one commit.

## Implementation notes

- Record only decisions justified by the frozen plan.
- Name contracts that must remain compatible.

## Negative cases

- State invalid input, failure, cancellation, or recovery behavior assigned to this task.

## Test evidence

- Name the command and the observable behavior it proves.
- Keep workflow screenshots under the active plan's `screenshot/` directory.

## Completion definition

- All assigned REQ and AC identifiers are covered.
- Changes remain within `write_scope`.
- Every `test_commands` entry passes and its evidence is recorded.

## Example

```markdown
---
id: "task-001-persist-notification-preference"
requirements: ["REQ-001"]
acceptance_criteria: ["AC-001"]
depends_on: []
surface: backend
read_scope: ["src/preferences/", "tests/preferences/"]
write_scope: ["src/preferences/store.ts", "tests/preferences/store.test.ts"]
test_commands: ["pnpm vitest run tests/preferences/store.test.ts"]
---

# Task

## Objective

Persist the authenticated user's email notification preference across sessions.

## Negative cases

- A failed repository write leaves the previously stored preference unchanged.

## Test evidence

- The targeted Vitest suite proves persistence, the existing default, and failed-write behavior.
```
