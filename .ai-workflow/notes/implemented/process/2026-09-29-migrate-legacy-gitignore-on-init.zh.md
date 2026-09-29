# Agent Note: 初始化与升级时迁移旧版 .gitignore 排除项

Status: implemented

[English](2026-09-29-migrate-legacy-gitignore-on-init.md) | 中文

## Problem

旧版 ai-workflow 会把整树 `.ai-workflow/` 条目连同 `*.log` 与 `MEMORY.md` 写入项目 `.gitignore`，共享的项目模板也携带同一段内容。当项目契约、`MEMORY.md`、navigation 与 notes 改为随 Git 后，这些遗留条目仍然藏起契约文件：`ai-workflow init` 与 `init --upgrade` 只追加缺失条目，并把已有的 `.ai-workflow/` 视为已覆盖 `.ai-workflow/plans/`，因此已采用 ai-workflow 的项目保留旧排除，契约文件始终未被 Git 跟踪。

## Decision

- `initializeProject` 与 `upgradeProject` 通过 `src/install/index.ts` 中的单一助手 `reconcileIgnoreFile` 原地整理项目 `.gitignore`：删除完全等于 `.ai-workflow`、`.ai-workflow/` 与 `MEMORY.md` 的遗留行，然后仅在缺失时追加 `.ai-workflow/plans/` 与 `.worktrees/`。
- 其余每一行（包括 `*.log`）都逐字节保留；`*.log` 及同类条目是 ai-workflow 不拥有的通用排除。
- 仅当整理后的内容不同才写入文件，因此重复升级返回空的 `created`，而失败运行仍通过既有事务回收机制恢复原始 `.gitignore` 字节。
- `tests/integration/project-cli.test.ts` 与 `tests/integration/project-upgrade.test.ts` 覆盖该迁移，`README.md` 也作说明；`.worktrees/` 保持被忽略，因为[忽略状态共享记录](./2026-09-14-share-ignored-state-into-worktree.md)要求如此。

## Alternatives considered

- **从受管模板重写整个 `.gitignore`。** 放弃：这会覆盖 ai-workflow 不拥有的用户与工具行。
- **保留遗留条目，把迁移留给用户。** 放弃：`MEMORY.md` 与 `.ai-workflow/` 其余内容是必须随 Git 的契约文件，而 CLI 知道旧版的确切输出，可以确定性地修复。
- **同时删除 `*.log`。** 放弃：`*.log` 是常见且与 ai-workflow 无关的既有排除，删除会让用户本想隐藏的日志不再被忽略。
- **匹配更宽的遗留变体，如 `/.ai-workflow/` 或 `.ai-workflow/*`。** 放弃：只有 ai-workflow 与共享模板写出的确切行才是已知输出，更宽的匹配有删除用户意图的风险。

## Consequences

- 从此以后每个初始化或升级的项目都只忽略 `.ai-workflow/plans/` 与 `.worktrees/`，因此 `MEMORY.md`、项目契约、navigation 与 notes 都随 Git 进入编码工作树。
- 已采用项目通过一次 `ai-workflow init <project> --upgrade` 完成迁移；在既有遗留 `.gitignore` 上执行全新 `init` 会在同一次运行中迁移，而已采用项目上的普通 `init` 仍按设计在冲突处停止。
- 没有活动记录被取代：[工作树策略记录](./2026-09-14-project-local-worktree-policy.md)与[忽略状态共享记录](./2026-09-14-share-ignored-state-into-worktree.md)仍然有效。
