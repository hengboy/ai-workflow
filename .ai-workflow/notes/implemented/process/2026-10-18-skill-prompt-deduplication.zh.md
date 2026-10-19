# Agent Note: Skill and sub-agent prompt deduplication with a mandatory tone

Status: implemented

[English](2026-10-18-skill-prompt-deduplication.md) | 中文

## Problem

已发布的技能与子代理提示模板累积了对同一工作流规则的重复复述与柔性模糊措辞，读者会多次遇到同一条规则，且部分要求读起来像是可选的。同一条规则会在一个文件的分流、前置条件、验证、工作区与同步各节中被重复，也会在每个子代理模板的 packet handling 与 output checklist 样板中反复出现。多条规范性表述使用了 `should`、`consider`、`try to`、`when it improves` 与 `if possible` 之类的模糊词，使同一要求可能被解读为可选。重复消耗了提示预算却未增加规范性内容，而柔性措辞使常见规则变得含糊。

## Decision

- **重复簇登记与等价规则。** 在每个范围内的提示文件中，每个已登记的重复簇只保留一条权威表述，并保留其原有规范内容。删除与合并只移除重复、复述与样板，绝不删除各自不同的规范内容。固定发布内容测试套件所断言的每一句都逐字保留，且 `tests/` 下没有任何文件被修改。
- **强制语气政策。** 规范性表述使用 `must`、`required`、`never` 或 `only`。范围内的提示文件中不出现 `should`、`consider`、`try to`、`when it improves` 与 `if possible` 等柔性模糊词，而 `may` 仅保留在真正的许可或可选字段语境中。
- **三处强化。** 编码技能的 `## Preconditions` 一节陈述强制的 Todo 列表规则，取代一条条件式条目并并入按比例的范围从句。编码技能的 `## Verification and Commit` 一节在需要命令裁决时要求派发 Test，取代原先的宽松表述。编码工作区参考把主动重建门槛表述为 `must not ... except at`，同时保留 `active rebuild` 关键词。
- **逐簇删除记录。** 每个簇的有界前后行数是验收证据：
  - 编码技能 `## Work-boundary synchronization`：23 → 7 物理行；保留单次 `ai-workflow sync-hook --host <host> --phase --project <root>` 调用、技能启动时一次性的节奏、存储结果复用与决策路由，删除手动同步与 stdin 载荷的复述。
  - 编码技能分流段尾部：删除已定请求的复述。
  - 编码技能 `## Delegation and Scheduling`：两条全新会话条目合并为一条，保留全部从句。
  - 编码技能 `## Preconditions`：条件式 Todo 条目被强制的 Todo 列表规则取代。
  - 编码技能 `## Implementation Record`：参考指针缩短为一个从句。
  - 编码技能工作区路由各节（`## Parent workspace execution`、`## Workspace finalization`）：裁去冗余的尾部从句。
  - 编码技能 `## Verification and Commit`：删除重复的引入段，并把 Test 派发改为必需。
  - 编码工作区参考 `templates/skills/coding/references/workspace.md`：激活、评审与恢复的复述各收敛为一条表述，并强化主动重建门槛。
  - 规划技能 `templates/skills/planning/SKILL.md` 的 `## Work-boundary synchronization`：5 → 4 内容行，并移除 agent-notes 治理的复述。
  - 计划转任务技能 `templates/skills/plan-to-tasks/SKILL.md`：分发后冻结规则缩减为一条带文件内引用的权威表述，裁去结果与调用模式的复述，且 `## Work-boundary synchronization` 为 5 → 4 内容行。
  - 九个代理解模板：`## Packet handling` 块各由 10 行内容压缩为 4 行内容（共删除 54 行），同时保留精确的绝对任务包路径、显式的逐命令 workdir、子仓库契约自读与 `no nested dispatch`；`## Output checklist` 块各失去两行冗余空行（共删除 18 行）。
  - git-operator 代理 `templates/agents/git-operator.md`：重复的定稿条目合并为单条权威指针提交表述（删除 5 行），保留整批 `git cat-file -e <sha>^{commit}` 存在性检查、绝不暂存部分批次规则以及精确的 `git update-index --cacheinfo 160000,<sha>,<path>` 指针写入命令。
  - 轻触文件（git-message、setup-ai-workflow、sync-ai-workflow 与 switch-profile 技能及其参考，以及规划与计划转任务的参考）：保持不变，因为在不动被断言句子的前提下不存在可移除的冗余。
- **实测净缩减。** 23 个范围内的文件由 2142 行降至 2032 行（−110），超过至少 100 行的目标。逐文件终值：`templates/skills/coding/SKILL.md` 352→329、`templates/skills/coding/references/workspace.md` 256→252、`templates/skills/planning/SKILL.md` 153→150、`templates/skills/plan-to-tasks/SKILL.md` 142→139、`templates/agents/git-operator.md` 128→115、`templates/agents/test.md` 71→63、`templates/agents/spec-review.md` 70→62、`templates/agents/standards-review.md` 67→59、`templates/agents/researcher.md` 66→58、`templates/agents/frontend.md` 64→56、`templates/agents/backend.md` 63→55、`templates/agents/file-explorer.md` 63→55、`templates/agents/documentation-maintainer.md` 62→54；其余范围内的文件均未改变。
- **无结构性变更。** 未引入跨文件引用链，也未引入主编排者内联或重读要求，且 frontmatter、标题与工具声明均未改变。

## Alternatives considered

- **整体重写提示模板。** 已否决：完全重写会改变规则措辞，破坏固定发布内容套件所依赖的逐字句子判据，从而在没有替代内容背书的情况下有丢失规范内容的风险。
- **超出已登记簇的删除。** 已否决：未登记删除会在没有任何簇等价背书的情况下悄然弱化或丢弃规范内容。
- **用跨文件指针替代复述。** 已否决：指针迫使主编排者阅读另一个文件，违反编排器上下文边界，以提示长度换取任务包模型并不提供的读取。
- **保持文件原样。** 已否决：至少 100 行的净缩减目标与强制语气都无法达成。

## Consequences

- 提示模板在保持工作流逻辑不变的前提下缩短 110 行，固定发布内容与安装测试套件在未编辑任何测试文件的情况下通过。
- 重复簇登记加等价规则可复用于后续措辞优化：新簇复用同一条仅移除重复的规则与同一逐字句子判据。
- `MEMORY.md` 与导航索引保持不变，因为没有标准、路径、符号或所有权改变，本笔记记录其原因。
- 强制语气政策使范围内文件中的每条规范性表述都明确，而 `may` 仅保留在真正的许可或可选字段语境中。
- [Orchestrator context boundaries in delegated coding](./2026-10-17-orchestrator-context-boundaries.md) 保留其证据、传输与重建决策；本记录仅删除它们在已发布提示中的重复复述，未改变其中任何决策。
- [Portable prompt transport and deterministic document maintenance](./2026-10-19-prompt-context-transport.md) 部分取代本记录有限的逐字重复做法，方法是在每个界面统一一份报告契约；本记录保留其重复簇登记、强制语气政策以及不删除任何被断言句子除非有等价替代的规则。
