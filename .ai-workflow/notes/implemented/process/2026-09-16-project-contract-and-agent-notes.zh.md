# Agent Note: Project contract and Agent Notes replacement

Status: implemented

[English](2026-09-16-project-contract-and-agent-notes.md) | 中文

## Problem

在本变更之前，ai-workflow 把完整工作流契约写进三个宿主的全局指令文件，并用 `.ai-workflow/adr/` 下的编号记录作为提案与决策机制。这带来了三个实际问题。第一，契约加载依赖宿主行为：项目侧没有独立、完整、可读的权威契约，全局块越写越长，缺少契约时也没有明确的修复入口。第二，决策记录的格式、生命周期、替代关系与封存规则分散在角色文件、技能和语言注入中，没有单一治理来源，规则容易漂移。第三，编号记录要求在 accepted 之后不可修改，无法用同一篇记录表达从提案到已实施的演进，也无法区分当前决定与仅作历史保留的封存内容。

本变更按已批准的冻结计划 `20260916-project-contract-and-agent-notes` 把完整项目契约迁入 `.ai-workflow/AGENTS.md`，并用项目内 Agent Notes 全量替代原有决策记录机制，不保留兼容路径。

## Decision

- 完整项目契约保存在 `.ai-workflow/AGENTS.md`，模板来源为 `templates/project/AGENTS.md`，明确适用于整个项目与所有参与代理。三个宿主的全局文件只保留一条短加载入口（模板来源 `templates/contract/AGENTS.md`），要求代理识别项目根并显式读取项目契约，不依赖宿主递归加载隐藏目录或自动展开 Markdown 链接。
- 契约缺失时报告 `.ai-workflow/AGENTS.md` 缺失并指向 `ai-workflow init <project-root> --upgrade`，把升级作为修复入口，不回退到旧的全局完整契约。
- `.ai-workflow/notes/` 成为唯一的提案与决策机制。`.ai-workflow/notes/README.md` 是格式、生命周期、替代关系与归档治理的单一来源；`.ai-workflow/notes/AGENTS.md` 与各级 AGENTS 只提供入口和局部维护边界；角色与技能引用该规范而不复制完整规则。
- `MEMORY.md` 记录当前标准（how），notes 记录原因（why），两者在同一变更内保持一致。
- 每篇 note 最初使用一种正文语言并遵循既有 `output_language`；`# Agent Note:` 标题、段落标题、字段名、`Status` 取值、路径与日期保持英文，不生成翻译副本、sidecar 或集中式索引。2026-09-17 的[双语 note 配对记录](./2026-09-17-bilingual-note-triplets.md)取代了这条单语言规则：每篇 note 现在都带有英文、中文与一致性记录三个同级文件，结构性元素保持英文，并且仍不生成集中式索引。
- 生命周期固定为 `proposed`、`implemented`、`rejected`、`archived`，类别固定为 `architecture`、`bug-fix`、`feature`、`process`、`simplification`、`testing`。状态必须与所在目录一致，implemented 记录改用 Decision 与 Consequences 描述已交付事实，不能只修改状态行。
- 归档只允许在语义审阅后移动 implemented 记录、插入归档日期并修复 active 入站链接；封存后字节由 `.ai-workflow/notes/archived/manifest.json` 的摘要保护。`ai-workflow notes archive --project <root> --seal` 先校验所有既有条目再原子追加新条目，失败不写清单，也不重建清单来接受已修改的历史。
- 项目升级使用显式入口 `ai-workflow init <project> --upgrade`：要求既有 `.ai-workflow/`、`MEMORY.md` 与两份导航；只创建缺失的管理文件与类别目录，跳过与模板一致的目标，返回 `created` 与 `skipped`；存在同名冲突或规则文件仍要求旧记录机制时，在任何写入前报告具体路径并停止。
- 用户历史数据保留：既有 `.ai-workflow/adr/` 文件、冻结计划、用户配置与已有 notes 正文都按原字节保留，不删除、不转换，也不进入 notes 的列表、校验与搜索。

## Alternatives considered

- 保留旧机制的兼容层（命令、别名、双写或运行时回退）。放弃原因是用户已明确要求 notes 全量替代且不写降级代码；双轨会让当前依据继续存在两套规则，并保留本应删除的读取路径。
- 由升级自动读取并转换历史记录。放弃原因是历史决定已经冻结，自动转换会重写用户数据，并可能把未交付的历史描述成当前事实；本次只保护历史字节，不读取其内容。
- 为 notes 生成双语配对、sidecar 或集中式索引。放弃原因是既有多语言偏好只需要单语言正文，额外产物会引入新的漂移来源与校验面。后续采用的更窄做法是带校验的一致性记录，见 2026-09-17 的[双语 note 配对记录](./2026-09-17-bilingual-note-triplets.md)。
- 复制参考项目的决策正文、旧格式豁免与历史归档清单。放弃原因是参考项目只用于理解组织方式与治理语义，不是本仓库的真实记录，复制会虚构决定与代价。

## Consequences

- 加载链变为「全局短入口 → `.ai-workflow/AGENTS.md` → notes 规范」，入口必须显式读取，宿主递归加载不再被假设。已经安装过旧入口但缺少项目契约的项目必须先执行升级，否则不能继续项目工作。
- 升级出现新的前置条件：`MEMORY.md` 或既有项目契约仍指示创建或读取旧记录机制时，升级报告具体文件与行并停止，人工合并后才能重试，没有降级或绕过模式。本次执行前已按计划显式合并 `MEMORY.md` 的旧标准，因此升级一次通过。
- 本次升级在本项目创建了 29 个生命周期与类别目录以及 6 个管理文件，`created` 列出全部产物且 `skipped` 为空；既有 `.ai-workflow/adr/` 历史、冻结计划与导航的字节未被改写。
- 旧记录机制的模块、命令、初始化分支、模板与现行指令被整体移除，发布物不再提供其列表功能；历史文件仅是本地数据，不再被读取。代价是历史资料不再被工具索引，需要人工查阅。
- notes 的语义正确性仍依赖人工审阅：机械校验只覆盖路径、日期、标题、状态与必需段落顺序、active 相对链接以及归档清单一致性，不能证明内容真实或决定已经交付。
- 归档是不可逆的字节冻结：封存后修改、移动、删除，或传入已被修改的历史文件，都会被 validate 与 `--seal` 拒绝；代价是历史 note 的出站链接可能过时且不再修复。
- 落地时 notes 树为空：加入本记录前 `notes list` 返回空列表，因此当时没有需要保留、合并或交叉链接的既有记录。此后 2026-09-17 的一次性迁移把五篇既有 ADR 记录补齐为 implemented notes 并建立交叉链接，见[迁移退役 ADR 记录到 notes](./2026-09-17-migrate-retired-adr-records-to-notes.md)；本次升级自身没有转换、读取或删除历史文件。
- 单一来源与用户历史的取舍是明确的：项目契约、notes 规范与导航 JSON 各自只有一个权威位置，而用户已有的本地历史文件保留原字节但不再是受支持的工作流输入。
