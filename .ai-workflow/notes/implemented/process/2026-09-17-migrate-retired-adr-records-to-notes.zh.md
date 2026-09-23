# Agent Note: Migrate retired ADR records to notes

Status: implemented

[English](2026-09-17-migrate-retired-adr-records-to-notes.md) | 中文

## Problem

2026-09-16 的[项目契约与 Agent Notes 替代记录](./2026-09-16-project-contract-and-agent-notes.md)把 Agent Notes 确立为唯一的提案与决策机制，并按当时的 Non-goals 把 `.ai-workflow/adr/` 下五篇 2026-09-14 的记录当作本地历史字节保留：产品不再读取、列出或校验它们。结果是这些记录中的问题背景、被否决方案与代价只能靠人工翻阅文件，无法通过 `ai-workflow notes list` 检索，也无法与当前机制建立链接。其中 0002、0003、0005 描述的机制已被 notes 与项目契约取代，0001、0004 仍是现行依据。历史理由若不可检索，后续维护者会重复已经评估并否决过的取舍，也无法分辨哪些旧结论仍然有效。

## Decision

- 一次性人工迁移这五篇记录为 implemented notes：0001 与 0004 作为仍然现行、由当前机制使用的依据记录；0002、0003、0005 作为已交付但机制已被取代的记录，在正文明确写出取代关系并交叉链接到[项目契约与 Agent Notes 替代记录](./2026-09-16-project-contract-and-agent-notes.md)。
- 迁移按 notes 的 implemented 结构忠实保留原记录的真实问题、决定、实际考虑过的备选方案及其被否决原因与代价；不补写未经记录的方案，不复制参考项目内容，也不保留未实施的计划段落。
- 迁移成功且 `ai-workflow notes validate` 通过后，删除 `.ai-workflow/adr/` 下的五个文件与空目录。
- 这是一次性人工动作，只针对本仓库的既有数据。产品行为不变：仍然没有 `adr` 命令、别名、转换入口、双写或回退；任何残留的历史文件依旧不被读取、列出或校验。用户显式授权本次偏离冻结计划 `20260916-project-contract-and-agent-notes` 的 Non-goals（“不自动删除用户已有的本地 ADR 历史文件”）；该授权仅限本次迁移，未改变可发布行为，也未恢复任何兼容路径。

## Alternatives considered

- **保留 ADR 原文件不迁移。** 考虑的原因是零风险、原字节完整；放弃原因是产品不再读取它们，检索成本与“历史理由与当前机制脱节”的问题仍然存在，也无法建立交叉链接。
- **只迁移仍然现行的 0001 与 0004。** 放弃原因是 0002、0003、0005 记录的备选方案与代价解释了当前 notes 与项目契约的由来，只迁移两篇会留下无法检索的历史空白。
- **迁移后同时保留原 ADR 文件。** 放弃原因是同一决定会出现两份不同格式的记录，读者难以判断哪份是当前依据；若保留副本还需逐篇标注取代关系，维护成本高于保留价值。
- **产品化转换命令（例如 `ai-workflow notes import-adr`）。** 放弃原因是产品已全量移除 ADR 机制且明确无兼容路径，为一次性本地数据引入新的公共命令会重新引入受支持面、帮助文本与测试负担。

## Consequences

- 五篇历史记录的理由、被否决方案与代价现在可通过 notes 目录与 `ai-workflow notes list` 检索：[项目内工作树策略](./2026-09-14-project-local-worktree-policy.md)与[将被忽略状态共享进工作树](./2026-09-14-share-ignored-state-into-worktree.md)作为当前依据；[读取时派生 ADR 列表](../simplification/2026-09-14-derive-adr-list-on-read.md)、[安装时本地化 ADR 正文](./2026-09-14-localize-adr-prose-at-install-time.md)与[把代理契约迁移到用户级全局指令文件](../architecture/2026-09-14-user-level-agent-contract.md)标明其机制已被取代。
- 删除不可恢复：原 `.ai-workflow/adr/*.md` 属于被 `.ai-workflow/` 覆盖的 gitignored、未跟踪本地数据，没有版本库副本、备份或哈希清单；删除后历史字节只存在于迁移后的 notes 正文中，而正文已按 notes 格式与当前事实改写，不再与原文逐字节一致。
- 产品与受支持工作流未改变：仍然没有 `adr` 命令、别名、转换或回退，残留历史文件依旧不被读取、列出或校验；本次迁移不构成受支持入口。
- 未把 0002、0003、0005 归档或标为 rejected：它们描述的是已交付后被取代的机制，不是被否决的提案，因此不进入 `rejected`；本次也未执行归档，因为归档需要单独的 `ai-workflow notes archive --seal` 步骤与语义审阅，且归档记录默认不再出现在 `notes list` 中，会降低这三篇作为解释来源的可达性。是否归档留待后续需要时由对应变更决定。
