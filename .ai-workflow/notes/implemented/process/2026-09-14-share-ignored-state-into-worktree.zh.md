# Agent Note: Share ignored state into the coding worktree

Status: implemented

[English](2026-09-14-share-ignored-state-into-worktree.md) | 中文

## Problem

强制编码工作树通过 `git worktree add` 创建，只检出受跟踪内容。因此 `MEMORY.md`、`.ai-workflow/` 以及其他所有被 gitignore 的路径都不会出现在工作树中，而编码必须读取冻结计划、`MEMORY.md`、navigation 与 notes，并且必须运行需要 `node_modules` 的测试。此前的规则只点名 `MEMORY.md` 与 `.ai-workflow`，这是不完整的：所需的被忽略集合还包括 `.ai-workflow/plans/` 下的每份计划文档、依赖与构建产物，并且会随每个项目增长。

## Decision

Git Operator 在 `git worktree add` 之后立即把项目完整的 gitignore 状态物化进编码工作树。它在项目根用 `git ls-files --others --ignored --exclude-standard --directory` 枚举该状态，排除持有工作树本身的 `.worktrees/` 容器，并对每个文件条目建立符号链接。对每个目录条目，它在工作树中创建真实目录，只对该目录的直接子项建立符号链接，因为 `.ai-workflow/` 这类带尾部斜杠的忽略模式匹配真实目录而不匹配目录符号链接，否则该链接会以未跟踪状态暴露。没有硬编码的路径清单，因此计划文档、navigation、notes、依赖与生成产物全部被覆盖。

被忽略状态保持单源于项目根：符号链接指回根目录文件，因此从工作树写出的 notes 与 screenshots 等产物落在根目录，删除工作树只删除链接。工作树仍是受跟踪源码编辑与分步提交的目标。该规则仍然现行，由 `coding` skill、`git-operator` 角色、项目契约与 `MEMORY.md` 一同声明。

## Alternatives considered

- **硬编码所需路径。** 否决：会遗漏计划文档、notes、依赖与构建产物，并随工作流增长而漂移。
- **把被忽略状态复制进工作树。** 否决：会复制大目录树、很快过期，并在删除工作树时丢失 notes 与 screenshots 等工作树写入。
- **不物化，改为始终从项目根的绝对路径读取。** 否决：相对读取与以工作树为 cwd 的工具仍会看不到被忽略路径，而且它不提供 `node_modules`。

## Consequences

- 编码可以通过工作树读取冻结计划、`MEMORY.md`、navigation、notes、依赖与构建产物，无需任何硬编码排除清单。
- 被忽略状态是共享而非复制的：在工作树内执行安装或构建会写回共享的根路径，因此依赖变更作为显式的隔离步骤处理，而不是通过复制。
- 工作树中的 `git status` 保持干净，因为链接的条目与项目 `.gitignore` 匹配。
- `.worktrees/` 必须留在项目 `.gitignore` 中，并且是唯一被排除在物化之外的条目。
- `coding` skill、`git-operator` 角色、项目契约与根 `MEMORY.md` 声明同一条规则，扩展了工作树策略。
