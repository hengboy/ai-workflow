# Agent Note: Project template synchronization

Status: implemented

[English](2026-10-08-project-template-sync.md) | 中文

## Problem

已采用 ai-workflow 的项目持有一份项目指令副本，但没有任何机制让这些副本与后续的上游模板保持一致，也不存在基线来区分过时的模板段落与协作者刻意的本地编辑。整文件复制会覆盖项目自有内容，而存储上一版模板基线已被否决。见[项目契约与 Agent Notes 记录](../process/2026-09-16-project-contract-and-agent-notes.md) 的早期升级入口只创建缺失的管理文件，遇到任何不一致文件就跳过或停止，因此既不能修补受管段落，也不能安全接管未标记的旧项目。

## Decision

- `ai-workflow sync [project]` 从固定远程来源 `hengboy/ai-workflow` 分支 `simplify` 修补既有采用；省略 project 时默认为当前实际目录并归一到其采用根。`ai-workflow init <project> --upgrade` 则复用随附的本地模板与空来源提交，因此修补受管段落但不作上游新鲜度声明。
- `src/sync/source.ts` 的 `resolveTemplateSnapshot` 以对固定公共地址 `https://github.com/hengboy/ai-workflow.git` 分支 `simplify` 的浅临时克隆获取模板，钉住唯一的 40 位十六进制不可变提交，在该提交下读取并校验每个受支持的 `templates/project` 文件的身份、编码、大小与结构，移除临时目录，且不读取任何令牌或凭据文件、不使用 GitHub CLI 或 SSH 配置；变更后的获取决策记录在[公共 git 模板来源](../simplification/2026-10-09-public-git-template-source.md)。获取失败或不完整会在任何目标变更之前返回 `unverified`、`verified: false` 与 `proceed: true`。
- 标记 `<!-- ai-workflow:section <id>:begin -->` 与 `<!-- ai-workflow:section <id>:end -->` 定义了 `src/sync/merge.ts` 中 `mergeOwnedSections` 唯一可替换的段落。begin/end 对必须唯一、不嵌套且格式良好；格式错误、重复、嵌套或未闭合的标记属于结构性冲突，不写入任何内容。
- `mergeOwnedSections` 只拼接来源中变更、新增或删除的受管段落正文，保留这些段落之外的每个字节（含行尾），保持既有项目自有片段顺序，按来源顺序追加新段落，并对不一致或未知的未标记旧正文给出警告而不是重复它。
- `src/sync/index.ts` 的 `applyTemplateSnapshot` 执行共享事务。它预检每个受管目标、既有归档清单、notes 结构目录与精确的 `.gitignore` 条目，冲突会在任何写入前阻止整个调用。成功时创建缺失目录、按文件原子发布变更并报告 `created`、`updated` 与 `skipped`。发布失败时恢复调用本地的原始字节并只移除本次调用新建的产物。
- 报告携带 `project`、`source`（`commit` 可为空）、`status`、`verified`、`proceed`、`check`、`created`、`updated`、`skipped`、`warnings` 与 `conflicts`。`synchronized` 退出 0，`unverified` 与 `needs_attention` 退出 2 且 `proceed: true`，`pending`、`conflict` 与 `failed` 退出 1；`--check` 在不写入的情况下计算判定与拟议变更。
- `applyTemplateSnapshot` 是唯一的修补核心。`upgradeProject` 以随附的本地模板和空来源提交复用它，因此报告 `needs_attention` 与未验证的本地来源警告，不作上游新鲜度声明，同时保留其缺失前置条件冲突与写入前精确的退役 ADR 祈使守卫。
- 六个可合并的项目 Markdown 模板带有稳定标记：`templates/project/AGENTS.md`、`templates/project/MEMORY.md`、`templates/project/notes/AGENTS.md`、`templates/project/notes/README.md`、`templates/project/notes/implemented/AGENTS.md` 与 `templates/project/notes/archived/AGENTS.md`。生成的导航、归档清单与 note 三元组保持数据特定并被保留。
- 门禁 `src/sync/gate.ts`（`runProjectGate`、`ProjectGateInput`、`ProjectGateOptions`、`ProjectGateResult`）从宿主事件与显式受支持路径解析实际采用根，按原生会话划分单元，或在 `PhaseEntry` 时按项目划分，在会话开始、用户轮次、恢复与实际根变更时使其失效，同根子代理复用父快照，仅豁免自身同步动作与更新权限的读取，并按报告严重程度把报告映射为 `allow`、`deny` 或 `skip`。
- `src/install/hooks.ts`（`installSynchronization`、`uninstallSynchronization`、`synchronizationPath`、`SynchronizationRecords`）仅增量安装、刷新与移除自有原生条目——OpenCode 插件 `.config/opencode/plugins/ai-workflow-sync.js`、Claude `~/.claude/settings.json` 钩子组与 Codex `~/.codex/hooks.json` 钩子组——保留无关钩子与设置，并为回滚快照被修改的原生配置。
- `ai-workflow sync-hook` 对每个宿主上的 `--phase` 形式与 OpenCode stdin 门禁打印原始门禁 JSON，而 Claude Code 与 Codex stdin 门禁打印宿主原生输出（`PreToolUse` 拒绝经由 `hookSpecificOutput.permissionDecision`，`UserPromptSubmit` 阻断则带顶层 `decision` 为 `block` 与 `reason`），绝不暴露原始的 `allow`/`deny`/`skip` 判定，且所有已处理形式都以 0 退出；门禁输出不报告信任或加载状态，携带 `trust_required`、`restart_required`、`disabled` 或 `needs_attention` 且 `active: false` 的是增量安装报告（`SynchronizationDeployment`）。随附的 `templates/skills/sync-ai-workflow/SKILL.md` 以增量 CLI 替代整文件复制路径。
- Coding、planning 与 plan-to-tasks 在每个未拆分实现步骤或每个冻结阶段之前调用 `ai-workflow sync-hook --host <current-host> --phase --project <actual-root>`，同根子代理复用父单元快照，在普通工作前重新读取或注入更新后的权限，并在范围冲突时停止而不是扩大范围。

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
- 验证在一次性临时 HOME 中安装全部三个宿主，使用 Node 22 `v22.23.2`，新构建的门禁在该环境中通过。
- OpenCode 1.18.35 自动加载了初始化器，且真实 SDK `session.get` 解析出实际会话目录，但执行仍未被验证：模型 API 在任何 chat、system 或 tool 钩子被记录之前返回 401 `missing_api_key`，因此门禁被跳过而非执行。Claude Code 2.1.229 需要交互式认证与未使用的独立凭据，Codex 0.155.1 需要钩子信任但无 TTY 且未使用绕过，因此两个钩子加载器仍未被验证。条目仅为已安装且初始化器已加载，绝不声称自动生效。
- 2026-09-14 的[用户级代理契约记录](../architecture/2026-09-14-user-level-agent-contract.md)被部分取代：其用户级标记块仍拥有加载入口，标记块所有权与历史理由得以保留，但已安装的 OpenCode 插件与 Claude/Codex 钩子条目现在也调用共享同步动作，因此其“仅全局入口”的执行方式不再描述完整的入口面。
- Codex 信任、OpenCode 重启与任何重复的宿主作用域技能仍是显式用户步骤；被禁用、未受信任或未加载的条目，以及 fail open 的宿主崩溃或超时，都作为执行限制而非成功阻断来报告。
- `.gitignore` 的精确调和与 notes 管理结构补齐复用了[旧式 .gitignore 迁移记录](../process/2026-09-29-migrate-legacy-gitignore-on-init.md) 确立的旧条目迁移；该记录的理由不变，仅其当前共享助手位置就地更正为 `src/sync/index.ts`，且只保留 `.ai-workflow/plans/` 与 `.worktrees/` 被忽略。
- 上游 `hengboy/ai-workflow` 分支 `simplify` 尚未带有所有权标记，因此实时尝试无法作出完整的管理新鲜性声明；观测到的真实运行报告 `unverified` 且 `created` 与 `updated` 均为空，完整声明须等待带标记模板发布到上游，而本计划未授权该发布。
- `uninstallSynchronization` 通过 `Reflect.deleteProperty` 从调用方的 `sync_hooks` 记录中移除每个被卸载宿主的自有条目，`uninstall` 持久化缩减后的 manifest，因此被卸载宿主不会留下过时所有权，之后重装可为新的用户组干净地重新注册原生条目；公共 API 不变。
- 上文门禁生命周期 Decision 条目与技能的按步骤及按阶段条目中的按边界节奏事实已被[技能启动时单次同步](2026-10-09-sync-once-at-skill-start.md)部分取代：自动同步现在按实际根在每次 planning、coding 或 plan-to-tasks 技能启动时运行一次，而本记录的检索、合并与报告契约仍然有效。
