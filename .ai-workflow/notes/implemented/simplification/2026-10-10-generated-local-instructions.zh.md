# Agent Note: Generated local project instructions

Status: implemented

[English](2026-10-10-generated-local-instructions.md) | 中文

## Problem

项目指令过去是按段落归属的：`ai-workflow sync` 与 `ai-workflow init --upgrade` 通过 `<!-- ai-workflow:section <id>:begin -->` / `<!-- ai-workflow:section <id>:end -->` 标记修补六个带标记的 `templates/project` Markdown 文件，其中根 `MEMORY.md` 也是其中之一。该方案把共享的通用工作流记忆保留在 `MEMORY.md` 内，迫使每个生成文件携带所有权标记，并把不一致的未标记段落视为有歧义的 `needs_attention` 内容。它还留下一个不安全的切换点：旧 CLI 搭配旧的带标记上游，可能在一个已经转换过的项目里恢复标记或改写本地记忆。

## Decision

- 恰好五个无标记生成文件由 `src/sync/artifacts.ts` 中的固定允许列表（`generatedArtifacts`）拥有：`templates/project/AGENTS.md` 对应 `.ai-workflow/AGENTS.md`，`templates/project/notes/AGENTS.md` 对应 `.ai-workflow/notes/AGENTS.md`，`templates/project/notes/README.md` 对应 `.ai-workflow/notes/README.md`，`templates/project/notes/implemented/AGENTS.md` 对应 `.ai-workflow/notes/implemented/AGENTS.md`，以及 `templates/project/notes/archived/AGENTS.md` 对应 `.ai-workflow/notes/archived/AGENTS.md`。
- 同步与随附模板升级把每个生成目标作为完整文件比较并替换，缺失则创建、完全一致则跳过；无标记生成文件中的手动编辑按设计会被覆盖。`src/sync/merge.ts` 及其 `mergeOwnedSections`、`validateOwnedSections` 与 `OwnershipConflictError` 被移除，不再保留段落解析器、同名段落接管或迁移。
- 根 `MEMORY.md` 归项目所有且仅在初始化时生成：全新 `init` 只在文件缺失时写入一个最小的本地骨架，同步与升级绝不替换、追加、规范化、与模板比较或迁移它。`templates/project/MEMORY.md` 只是该初始化期引导骨架，其独有的通用执行、TDD、会话交接与宿主原生角色事实已迁入 `templates/project/AGENTS.md`。
- 来源校验要求一个完整的五成员快照，每个成员都是带有非空一级标题且不含旧式 `ai-workflow:section` 标记的非空 Markdown。成员缺失或畸形会报告 `unverified`、`verified: false`、`proceed: true` 且零目标写入，而仍携带旧式标记的目标会在任何写入前以 `conflict` 连同其路径与手动替换说明被拒绝。
- 共享的产物校验位于 `src/sync/artifacts.ts`（`generatedDocumentError`、`validateGeneratedSnapshot`、`hasLegacySectionMarker`），而 `src/sync/index.ts`（`applyTemplateSnapshot`、`synchronizeProject`、`reconcileIgnoreFile`、`notesStructureDirectories`）是发布核心，`upgradeProject` 以随附本地模板与空来源提交复用它。
- 切换顺序是：刷新受管 CLI 与宿主入口命令，把项目内容保留在 `MEMORY.md` 中，手动替换生成文件，用新 CLI 校验，然后才启动下一次工作流技能；把无标记模板发布到上游是用户负责的外部动作。
- 三种组合保持区分：新 CLI 搭配旧格式上游为 `unverified` 且不写入，旧 CLI 搭配新的无标记上游在其自身的来源校验中失败，而旧 CLI 搭配旧的带标记上游针对新的无标记目标可能恢复标记或改写 `MEMORY.md`，绝不能声称其零写入安全。若该窗口发生，检查已披露路径、保留项目事实、刷新 CLI 与入口、恢复 `MEMORY.md` 并重新替换生成文件。

## Alternatives considered

- 为生成文件保留段落级所有权标记。放弃原因是整文件所有权更简单、匹配无标记上游，并消除了标记方案仍然携带的基线与同名段落歧义。
- 让根 `MEMORY.md` 继续作为被同步文件。放弃原因是它把项目架构与标准同生成的通用工作流指令混在一起，并使本地编辑不安全；它现在仅在初始化时生成且归本地所有。
- 自动迁移仍带标记的项目。放弃原因是旧格式无法区分生成内容与项目内容，迁移会重写本地数据；转换是操作者的手动步骤。
- 新增 `AGENTS.local.md`、`.ai-workflow/MEMORY.md`、生成的摘要清单或存储的基线。放弃原因是固定的五文件允许列表与仅初始化的本地记忆不需要额外文件，也不需要存储历史。

## Consequences

- 每个宿主的项目指令恰好是五个生成文件加上本地 `MEMORY.md`；契约拥有 `MEMORY.md` 不再重复的通用执行、TDD、会话交接与宿主原生角色规则。
- 生成文件中的手动编辑会在下次同步时按设计被替换，因此项目新增内容应放入 `MEMORY.md` 或 notes。
- 带标记的旧项目需手动转换，而旧 CLI/旧上游/新目标的窗口需要显式的操作者排序与恢复，因为旧二进制无法校验新格式。
- 语义正确性仍依赖审阅：机械校验检查存在性、无标记结构、路径、状态与报告形态，而非生成文件是否真实。
- [项目模板同步](../feature/2026-10-08-project-template-sync.md)、[项目契约与 Agent Notes 替换](../process/2026-09-16-project-contract-and-agent-notes.md)、[技能启动时单次同步](../feature/2026-10-09-sync-once-at-skill-start.md) 与 [公共 git 模板来源](../simplification/2026-10-09-public-git-template-source.md) 记录被部分取代：它们的节奏、门禁、检索与治理理由仍然有效，而其带标记六文件、段落合并与标记结构事实被五个无标记文件的整文件所有权取代。
