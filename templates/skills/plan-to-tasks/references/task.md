---
id: "{{task_id}}"
requirements: ["REQ-001"]
acceptance_criteria: ["AC-001"]
depends_on: []
surface: backend
read_scope: [".ai-workflow/AGENTS.md", "MEMORY.md", ".ai-workflow/index/navigation.json", ".ai-workflow/index/navigation.md", "{{exact/locator/file.ts}}"]
write_scope: ["{{exact/write/file}}"]
test_commands: ["{{targeted_test_command}}"]
---

# Task

English | [中文](task-NNN-slug.zh.md)

## Bilingual shape

Each task is a complete bilingual triplet under `tasks/`: the English main document `tasks/task-NNN-slug.md`, the Chinese prose side `tasks/task-NNN-slug.zh.md`, and the `tasks/task-NNN-slug.i18n.yaml` consistency record. Only `tasks/task-NNN-slug.md` is the task document used for enumeration; `.zh.md` and `.i18n.yaml` are its companions and are never enumerated as tasks.

The Chinese `.zh.md` side has no YAML frontmatter and starts with `# Task` followed by the Chinese switcher:

```markdown
# Task

[English](task-NNN-slug.md) | 中文

（中文正文，结构镜像英文侧；无 YAML frontmatter。）
```

Frontmatter (`id`, `requirements`, `acceptance_criteria`, `depends_on`, `surface`, `read_scope`, `write_scope`, `test_commands`) lives only on the English `task-NNN-slug.md` side. Both sides mirror headings, structure, tables, lists and link targets, differing only in prose.

## Objective

State one coherent, independently testable outcome that can be delivered in one commit. Keep it cohesive: do not open a task for a per-file or mechanical edit, and merge work that shares one outcome, surface and validation command.

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
read_scope: [".ai-workflow/AGENTS.md", "MEMORY.md", ".ai-workflow/index/navigation.json", ".ai-workflow/index/navigation.md", "src/preferences/store.ts", "tests/preferences/store.test.ts"]
write_scope: ["src/preferences/store.ts", "tests/preferences/store.test.ts"]
test_commands: ["pnpm vitest run tests/preferences/store.test.ts"]
---

# Task

English | [中文](task-001-persist-notification-preference.zh.md)

## Objective

Persist the authenticated user's email notification preference across sessions.

## Negative cases

- A failed repository write leaves the previously stored preference unchanged.

## Test evidence

- The targeted Vitest suite proves persistence, the existing default, and failed-write behavior.
```

The Chinese companion `task-001-persist-notification-preference.zh.md` has no frontmatter and starts with the same title and the Chinese switcher:

```markdown
# Task

[English](task-001-persist-notification-preference.md) | 中文

## 目标

在会话之间持久化已认证用户的邮件通知偏好。

## 负向用例

- 仓库写入失败时保留此前已存储的偏好。

## 测试证据

- 针对性 Vitest 套件证明持久化、既有默认值与写入失败行为。
```
