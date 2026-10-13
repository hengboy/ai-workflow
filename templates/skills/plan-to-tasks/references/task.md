---
id: "{{task_id}}"
requirements: ["REQ-001"]
acceptance_criteria: ["AC-001"]
depends_on: []
repo: "{{repo}}"
surface: backend
read_scope: [".ai-workflow/AGENTS.md", "MEMORY.md", ".ai-workflow/index/navigation.json", ".ai-workflow/index/navigation.md", "{{exact/locator/file.ts}}"]
write_scope: ["{{exact/write/file}}"]
test_commands: ["{{targeted_test_command}}"]
---

# Task

English | [中文](task-NNN-slug.zh.md)

## Bilingual shape

Each task is a complete bilingual triplet under `tasks/`: `task-NNN-slug.md`, `task-NNN-slug.zh.md` and `task-NNN-slug.i18n.yaml`. Only the English `.md` is used for task enumeration, routing and dependency checks; companions are never enumerated as tasks.

The Chinese `.zh.md` side has no YAML frontmatter and starts with `# Task` followed by the Chinese switcher:

```markdown
# Task

[English](task-NNN-slug.md) | 中文

（中文正文，结构镜像英文侧；无 YAML frontmatter。）
```

Frontmatter lives only on the English side. Mirror headings, structure, tables, lists and link targets; only prose differs. Use both switchers shown above.

## Field contract

Replace every placeholder with usable values for all applicable fields:

- `id`: sequential `task-001-short-slug`, `task-002-short-slug` IDs.
- `requirements`, `acceptance_criteria`: assigned frozen REQ/AC IDs; explain intentional shared coverage.
- `depends_on`: task IDs justified by data, contract, ordering or overlapping-write constraints, subject to Repository scope below.
- `repo`: the conditional repository assignment below; remove the illustrative field for a non-workspace plan.
- `surface`: non-empty `backend|frontend|cross-stack|test|docs|research|documentation`, converted from the plan's `Responsible role`. `research` delegates every technology, project, concept, topic or keyword research request to Researcher, whether or not links are supplied; `documentation` routes non-code documentation and index maintenance to Documentation Maintainer.
- `read_scope`: fixed context (`.ai-workflow/AGENTS.md`, `MEMORY.md`, both navigation files) plus exact locator paths and exact bounded note/governance paths. Never use `src/`, `tests/` or the project root.
- `write_scope`: exact enough for filesystem enforcement; never `.`, the project root, `**`, unresolved placeholders or broad directories with unclear ownership.
- `test_commands`: assigned validation commands; state expected evidence in the body. Place frontend/backend checks on their responsible tasks and add integration work only when cross-stack behavior requires it.

## Objective

State one coherent, independently testable outcome that can be delivered in one commit. Keep it cohesive: do not open a task for a per-file or mechanical edit, and merge work that shares one outcome, surface and validation command.

## Repository scope

In a workspace plan, frontmatter `repo` names the single repository this task belongs to. `repo` is `required exactly when the plan declares repositories` and `forbidden otherwise`; a task in a plan without `workspace_repos` must not carry it.

Task read and write scopes are `repository-relative`: they resolve inside that repository's root, never against the workspace root, and must not escape it with `..`.

A task never declares a `cross-repository` `depends_on`: every dependency names a task in the same repository. Repository ordering comes from the plan's declared repository order, not from task `depends_on`.

## Finalization coverage

Root finalization criteria declared by `workspace_finalization` `never become` tasks: they remain root-owned, are not assigned to any repository and are not sliced. Finalization ACs must be disjoint from task ACs; requirements may overlap. A task must not claim a `finalization-only` AC. Complete plan coverage is the union of task and separately validated finalization coverage.

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
