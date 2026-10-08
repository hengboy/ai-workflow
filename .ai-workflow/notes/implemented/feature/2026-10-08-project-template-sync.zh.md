# Agent Note: Project template synchronization

Status: implemented

[English](2026-10-08-project-template-sync.md) | 中文

## Problem

已采用 ai-workflow 的项目持有一份项目指令副本，但没有任何机制让这些副本与后续的上游模板保持一致，也不存在基线来区分过时的模板段落与协作者刻意的本地编辑。整文件复制会覆盖项目自有内容，而存储上一版模板基线已被否决。见[项目契约与 Agent Notes 记录](../process/2026-09-16-project-contract-and-agent-notes.md) 的早期升级入口只创建缺失的管理文件，遇到任何不一致文件就跳过或停止，因此既不能修补受管段落，也不能安全接管未标记的旧项目。

## Decision

- `ai-workflow sync [project]` 与 `ai-workflow init <project> --upgrade` 从固定来源 `hengboy/ai-workflow` 分支 `simplify` 修补既有采用；省略 project 时默认为当前实际目录并归一到其采用根。
- `src/sync/source.ts` 的 `resolveTemplateSnapshot` 解析分支 HEAD，要求唯一的 40 位十六进制不可变提交，在该提交下列出每个受支持的 `templates/project` 目录与文件，校验清单以及每个文件的身份、编码、大小与结构，并按 `GH_TOKEN` 先于 `GITHUB_TOKEN` 读取为显式 bearer 授权头。获取失败或不完整会在任何目标变更之前返回 `unverified`、`verified: false` 与 `proceed: true`。
- 标记 `<!-- ai-workflow:section <id>:begin -->` 与 `<!-- ai-workflow:section <id>:end -->` 定义了 `src/sync/merge.ts` 中 `mergeOwnedSections` 唯一可替换的段落。begin/end 对必须唯一、不嵌套且格式良好；格式错误、重复、嵌套或未闭合的标记属于结构性冲突，不写入任何内容。
- `mergeOwnedSections` 只拼接来源中变更、新增或删除的受管段落正文，保留这些段落之外的每个字节（含行尾），保持既有项目自有片段顺序，按来源顺序追加新段落，并对不一致或未知的未标记旧正文给出警告而不是重复它。
- `src/sync/index.ts` 的 `applyTemplateSnapshot` 执行共享事务。它预检每个受管目标、既有归档清单、notes 结构目录与精确的 `.gitignore` 条目，冲突会在任何写入前阻止整个调用。成功时创建缺失目录、按文件原子发布变更并报告 `created`、`updated` 与 `skipped`。发布失败时恢复调用本地的原始字节并只移除本次调用新建的产物。
- 报告携带 `project`、`source`（`commit` 可为空）、`status`、`verified`、`proceed`、`check`、`created`、`updated`、`skipped`、`warnings` 与 `conflicts`。`synchronized` 退出 0，`unverified` 与 `needs_attention` 退出 2 且 `proceed: true`，`pending`、`conflict` 与 `failed` 退出 1；`--check` 在不写入的情况下计算判定与拟议变更。
- `applyTemplateSnapshot` 是唯一的修补核心。`upgradeProject` 以随附的本地模板和空来源提交复用它，因此报告 `needs_attention` 与未验证的本地来源警告，不作上游新鲜度声明，同时保留其缺失前置条件冲突与写入前精确的退役 ADR 祈使守卫。
- 六个可合并的项目 Markdown 模板带有稳定标记：`templates/project/AGENTS.md`、`templates/project/MEMORY.md`、`templates/project/notes/AGENTS.md`、`templates/project/notes/README.md`、`templates/project/notes/implemented/AGENTS.md` 与 `templates/project/notes/archived/AGENTS.md`。生成的导航、归档清单与 note 三元组保持数据特定并被保留。

## Alternatives considered

- 用整份模板文件覆盖项目目标。放弃原因是它会破坏项目自有标准与架构，且无法区分过时段落与刻意编辑。
- 存储上一版模板快照或项目版本戳以计算差异。放弃原因是已批准策略不存储基线；定义可替换内容的是所有权标记，而非存储的历史。
- 在来源不可用或未标记段落不一致时阻止所有工作。放弃原因是已批准策略对来源失败与有歧义的旧内容继续并显示警告，只阻塞结构性或发布失败。
- 让同步重写导航、note 正文、归档清单、冻结计划或根用户指令。放弃原因是这些属于数据特定或用户自有内容，受支持的可写集合仍只是六个带标记模板加上缺失的管理结构与忽略条目。
- 允许任意仓库或 ref、历史缓存或项目本地运行记录。放弃原因是来源固定，存储基线或额外记录会重新引入该策略已移除的漂移与校验面。

## Consequences

- 升级记录的仅缺失行为被部分取代：共享核心现在修补受管段落、报告 `updated`，并把不一致的管理文件视为合并或警告而非中止，而它同时描述的前置条件、ADR 守卫与保留字节的历史规则仍见[项目契约与 Agent Notes 记录](../process/2026-09-16-project-contract-and-agent-notes.md)。
- 没有基线时，不一致的未标记同名段落无法被接管，会连同 `needs_attention` 被保留；只有正文完全一致的段落才能获得标记，明显缺失的带标记段落只插入一次。
- 退役的来源产物保留其现有目标并给出警告而不是删除，未受支持的目标不会扩大可写集合。
- 标记是授权边界而非旧内容的记录，因此刻意放在正确声明的受管段落内的编辑会跟随最新模板。
- 同步不执行任何 Git 操作，只写当前实际项目的受管文件，并要求普通 worktree、干净树与范围门禁被遵守而不是被绕过。
- 本记录只覆盖已交付的 CLI 与合并核心；会在工作边界自动运行同步的原生宿主触发入口不属于本交付步骤。
