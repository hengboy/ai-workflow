# Agent Note: 规划与拆分后的工作区会话交接

Status: implemented

[English](2026-10-08-workspace-session-handoff.md) | 中文

## Problem

已发布的下一次会话指引止步于单一无条件路径。Planning 的完成清单、`coding` 技能的无冻结计划路径以及 README 都告诉每个 planned change 在新会话中调用 coding 技能。一旦工作区计划声明了至少一个非根参与仓库，这条路径就是错的，因为此类计划必须先由 plan-to-tasks 拆分并分发，任一仓库才能实施切片。遵循旧文本的用户会为一个没有任何子仓库收到的计划进入编码会话，编码入口随后拒绝该未分发计划，白白浪费这次会话。同一缺口还使 plan-to-tasks 的拆分完成缺少下一次 Coding 交接，使 coding 的切片完成缺少下一仓库或定稿交接，也使定稿规则缺少 `ready_for_finalization` 就绪报告与新的根会话步骤。

## Decision

- Planning 的 `## Completion checklist` 按 `workspace_repos` 条件路由：声明至少一个非根参与仓库的计划，告知用户在 `<workspace-root>` 启动新会话并用绝对冻结计划目录调用 plan-to-tasks，然后在校验之后、实施之前运行 `ai-workflow workspace distribute --plan <directory>`，且暂不调用 coding；普通计划或 `workspace_repos` 只声明保留 workspace 根条目的仅根条目工作区计划，告知用户在新会话中调用 coding 技能。Planning 报告绝对项目或工作区根、冻结计划目录、`plan validate` 结果以及每个参与者的 name、path 与 `depends_on` 顺序，并包含一段可复制提示。
- `coding` 技能的 `## Change routing` 无冻结计划路径遵循同样的分流：工作区计划经由 plan-to-tasks 与分发，普通或仅根条目计划经由 coding 技能，且规划会话仍不创建 worktree、不创建实施记录、不派发实施或评审，也不提交。
- 编码入口与切片规则指明父工作区根会话和绝对父工作区计划目录：未分发的计划在仍需拆分时指向 plan-to-tasks，在拆分工件已存在时指向重跑 `ai-workflow workspace distribute --plan <directory>`；没有切片清单的参与仓库则把同一分发重跑命名为其修复。
- plan-to-tasks 的 `## Workspace split` 完成报告每个参与仓库的 name、path 与切片状态（`written` 或 `unchanged`）、校验与分发结果、保留根条目（状态为 workspace-root，而非 written 或 unchanged，因为其任务留在根计划中）、含根任务的冻结 `delivery order`，以及对父工作区计划目录读取的 `ai-workflow workspace status --plan <directory>`。它会提供一段可复制文本提示：在工作目录 `<repository-root>` 调用 coding 技能，按冻结顺序从本地冻结计划目录 `<repository-plan-directory>` 仅实施本仓库任务，并针对原始父目录运行 `ai-workflow workspace status --plan <workspace-plan-directory>`。冻结交付阶段来自 `tasks/execution-order.yaml` 与每个仓库的 `depends_on`；`workspace status` 的 `next_repository` 现在遵循该冻结的仓库首次出现顺序，并包含待交付的根拥有任务，因此它与冻结排程一致而不是覆盖它，且根拥有的任务保留其位置，可以先于依赖它的子仓库。
- Coding 切片完成报告交付 SHA，并用绝对父工作区计划目录运行 `ai-workflow workspace status --plan <directory>`，按冻结交付顺序交接下一仓库、路径、会话与提示，沿用拆分交接的 `<repository-root>`/`<repository-plan-directory>`/`<workspace-plan-directory>` 约定。定稿要求每个子切片 `present` 且 `completed`，并且根拥有的任务交付边界被满足，因此子会话绝不自行定稿。
- `coding` 技能的 `## Workspace finalization` 保留只读 Git 交付提交校验与 pin 限制，并增加 `ready_for_finalization` 报告；定稿仅在 `valid` 为 true、每个子切片的 `slice` 为 `present` 且 `record` 为 `completed`，并结合根条目的 `tasks_delivered`（单记录 `root_tasks_commit` 交付边界）与只读 Git 交付提交校验时才消费该报告，且该报告针对原始父目录 `<workspace-plan-directory>` 读取。子仓库或其他仓库会话报告可复制的下一根会话提示，而已经在运行的、正确的父定稿会话执行定稿且不会重新开启自身；该提示在工作区根 `<workspace-root>` 调用 coding 技能，运行 `ai-workflow workspace status --plan <workspace-plan-directory>`，并仅在这些条件成立后才 pin。
- `README.md`、`MEMORY.md` 与 `templates/project/MEMORY.md` 携带同样的条件路由，因此不再残留无条件调用 coding 的陈旧事实。

## Alternatives considered

- **保留单一无条件 coding 交接，让编码入口再分流。** 放弃：编码入口只有在用户已经进入错误会话之后才拒绝未分发计划，因此该拒绝是死胡同式往返，而不是正确的下一步动作。
- **由规划会话分发。** 放弃：规划只拥有工作区根这一对 `spec.md`/`plan.md`，从不写切片，而分发需要拆分产出的任务三元组、配对记录和 `workspace.yaml`，所以分发属于 plan-to-tasks 拆分会话，与既有的分发交接记录一致。
- **在拆分后规定子仓库优先交付。** 放弃：根拥有的任务在 `tasks/execution-order.yaml` 中保留其冻结位置，并且可以先于依赖它的子仓库，因此子仓库优先指令会与冻结顺序矛盾。
- **为交接新增命令或 JSON 字段。** 放弃：`ai-workflow workspace status --plan <directory>` 已经报告 `ready_for_finalization` 与 `next_repository`，所以只需让指引追上既有输出。
- **从发现结果重建整个 navigation 索引。** 放弃：本仓库已经带有宽泛的自动发现特性（`root`、`src`、`tests`），发现式重建会替换精选索引，且无法加入这个有界特性，因此本次更新保留既有特性并新增一个。

## Consequences

- Planning、plan-to-tasks 与 coding 的路由，连同 `README.md`、`MEMORY.md` 与 `templates/project/MEMORY.md`，现在就在条件式、工作区感知的交接上保持一致，旧的单一无条件路径事实已移除。
- 已发布模板内容由 `tests/behavior/change-routing.test.ts`、`tests/behavior/workspace-planning-content.test.ts` 与 `tests/behavior/workspace-workflow-content.test.ts` 守护，它们断言技能、README 与 MEMORY 文本，包括随附的文本围栏提示；证据范围是已发布文本，而不是多仓库拆分的运行时执行。
- navigation 索引新增一个有界的 `workspace-handoff` 特性，指向三个技能文件、它们的引用、`README.md`、两个 `MEMORY.md` 文件与三个行为测试，已有的模块根定义保持不变。
- 本记录部分取代 [规划与编码的会话边界记录](../process/2026-09-23-planning-coding-session-boundary.md) 中的无条件单会话交接事实，并为 [工作区拆分分发交接记录](../process/2026-10-02-workspace-distribute-handoff.md) 增添上下文；两份记录都保留其决定与理由，且其当前交接事实指向本记录。
- 本记录仅针对子仓库的就绪与仅作参考的 `next_repository` 事实，被 [工作区执行一致性记录](./2026-10-08-workspace-execution-consistency.md) 部分取代；该记录记载了清单校验、冻结顺序的 `next_repository`、根条目的 `tasks_delivered`/`delivery_commit` 与 `root_tasks_commit`；本记录保留其条件式交接决定与理由，且其当前交付边界事实指向该记录。
- [工作区编码编排记录](../feature/2026-10-09-workspace-coding-orchestration.md) 以已交付的父会话准备、按仓库 worktree、检查点命令与分离评审部分取代本记录的交接措辞；本记录保留其条件式交接决定与理由。
