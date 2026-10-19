# Agent Note: Archive the spent ADR-era records

Status: implemented

[English](2026-10-19-archive-retention.md) | 中文

## Problem

把退役 ADR 文件迁入 Agent Notes 的一次性迁移有意推迟了这批迁移记录的最终保留决定：它让每一篇迁移记录都保持 active，并把任何归档步骤留给后续变更，因为归档会把记录从 `ai-workflow notes list` 中移除，需要单独审阅其未来指引价值。这一推迟使该批记录缺少一份已记录的评估，读者因此无法分辨哪些迁移记录仍能指引未来工作、哪些只是历史。

## Decision

- 把[安装时本地化 ADR 正文](../../archived/process/2026-09-14-localize-adr-prose-at-install-time.md)与[迁移退役 ADR 记录到 notes](../../archived/process/2026-09-17-migrate-retired-adr-records-to-notes.md)归档到 `archived/process/` 下。二者都是已完成、未来指引已耗尽但保留历史决策价值的 implemented 决定，正是 `.ai-workflow/notes/README.md` 拥有的保留政策为该情形保留的归档结果。
- localize 记录的机制已完全退役：ADR 专有结构字段与撰写规则被移除，安装期语言注入也随 `output_language` 特性一并移除。保留它是为了解释安装期本地化为何存在，并使取代链条可读。
- migrate 记录描述的是一次已完成、不可恢复的一次性本地数据迁移，其原始字节已不存在，且没有任何后续工作流步骤依赖其结果。保留它是为了说明该迁移为何是一次性人工动作、且没有产品化转换路径。
- 让[读取时派生 ADR 列表](../simplification/2026-09-14-derive-adr-list-on-read.md)保持 active：其「读取时派生投影、而非存储生成的副本」的决定仍在指引本项目如何对待诸如导航索引与 note 查询这类派生产物，其被否决的备选方案对该选择仍有意义。
- 让[把代理契约迁移到用户级全局指令文件](../architecture/2026-09-14-user-level-agent-contract.md)保持 active：用户级标记块机制、其归属记录与历史理由仍然有效，改变的只是完整契约文本所在的层级。
- 本处置即迁移记录所推迟的评估；它补全该记录留下的开放问题，而不改变任何已记录的决定。

## Alternatives considered

- **让所有迁移记录保持 active。** 已否决：其中两篇已不再指引未来工作，让它们保持 active 会模糊哪些记录仍承载当前理由、哪些仅作历史保留。
- **删除这两篇已耗尽的记录。** 已否决：二者仍保留历史决策价值，而删除只保留给没有持久决策价值的记录；删除也不可恢复，并会丢掉关于那次一次性迁移的唯一记述。
- **把仍有指引作用的记录也一并归档。** 已否决：读取时派生原则与用户级标记块机制仍指引未来工作，归档它们会移除可达的当前指引。

## Consequences

- `ai-workflow notes list` 只报告仍指引当前工作的记录，而 `ai-workflow notes list --archived` 把这两篇已耗尽的 ADR 时代记录作为封存历史报告。
- 归档后的 localize 与 migrate 记录被冻结：其字节与归档日期由归档清单保护，其出站链接不再修复。
- [移除 output_language 配置](../simplification/2026-09-18-remove-output-language.md)与[项目契约与 Agent Notes 替代记录](./2026-09-16-project-contract-and-agent-notes.md)中的 active 入站链接指向归档路径，因此 active 读者能解析每一处历史引用。
- 保持 active 的两篇记录继续解释其当前机制，因此关于派生投影与用户级入口归属的未来工作仍有可达的理由。
