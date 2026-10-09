# Agent Note: 父工作区编码编排

Status: implemented

[English](2026-10-09-workspace-coding-orchestration.md) | 中文

## Problem

Planning 可以冻结一份跨仓库工作区计划，技能也可以指向新的父会话，但已发布的工作流仍然没有父侧执行。Coding 指示在每个参与仓库中手动开启会话，实施记录没有任务级检查点协议，而 `workspace status` 只报告过滤后切片排程上单一的参考性 `next_repository`。没有任何规则定义：一个父会话如何激活该边界、准备拆分、把原生叶子派发进按仓库划分的 worktree、保留冻结的父阶段与交付屏障、通过一条文件系统命令写入按任务的检查点、把按仓库交付评审与定稿评审分开，或在阶段被中断时有界地恢复。

## Decision

- 激活是精确的：只有冻结计划声明了至少一个与当前根 `.gitmodules` 匹配的非根参与仓库时，才进入父编排。普通计划、`workspace_repos` 只声明保留 `workspace` 根条目的仅根条目工作区计划，以及带有 `.gitmodules` 却运行非参与计划的项目，全部保持既有的直接、机械、免拆分或拆分路径不变。
- 唯一的父 Coding 主会话拥有编排。当其冻结的子仓库参与计划没有任务集时，会话把 `plan-to-tasks` 作为获批准备流程调用：展示完整批准预览，写出并校验任务三元组、排程与 `workspace.yaml`，运行 `ai-workflow workspace distribute --plan <directory>`，并把控制权交回同一会话；独立调用 plan-to-tasks 仍然结束。不存在嵌套拆分器、协调者、远程会话或子主机进程，且拒绝批准不会创建任何任务、切片、worktree 或实施记录。
- 每个活动仓库恰好拥有一个按活动仓库划分的本次运行 worktree，位于 `<source-root>/.worktrees/<planId>`，分支为 `ai-workflow/<planId>`；父 worktree 不是子实现容器，其子模块目录保持为空。只有 Git Operator 运行 Git：校验每个仓库真实的 Git common directory（因此目录名相同并不能证明身份），物化其忽略状态，对照任务写入范围检查每个范围内任务提交的确切父提交与重命名的两个端点，执行非快进交付集成，并只清理本次运行拥有的 worktree 与分支。
- 原始父 `tasks/execution-order.yaml` 仍然是唯一的全局排程。其阶段按文件顺序运行；当前阶段彼此独立的任务并发派发，整个阶段被等待并校验后，才按顺序写入其范围内提交；到达最后一个任务阶段的仓库在依赖它的仓库推进之前完成按仓库交付门禁。过滤后的切片排程或重算的 DAG 都不授予派发权。
- 每个仓库保留其单一的 `implementation.yaml`，新字段只存在于新的工作区执行记录上。`execution` 携带 purpose（`tasks` 与仅根的 `finalization`）、规范的 `source_root`、`repository`、绝对 `worktree`、`branch`、`target_branch` 与仓库本地 `base_commit`；`task_checkpoints` 把每个本地冻结任务 ID 映射到写入型 `kind: commit` 及其完整 SHA，或映射到已校验未变更的 `kind: no-change` 及其确切 HEAD；按 purpose 作用域的 `reviewed_commit` 记录确切解析的当前 purpose HEAD。记录仍然只暴露 `in-progress` 与 `completed` 两个顶层状态。
- `ai-workflow workspace checkpoint --plan <directory> --repo <name>` 是唯一的写入者。它只接受 stdin 上的恰好一个 JSON 事件——`start`、`task`、`reviewed`、`delivered` 或 `finalized`——在写入前拒绝未知字段、错误类型、错误的计划或仓库、未授权任务 ID、矛盾重复、非法转换与格式错误的完整 SHA，对相同重复事件幂等，并通过共享原子写入器发布，因此拒绝时先前记录保持字节不变。它保持仅文件系统；主会话只在所需的 Git Operator 与评审结果之后调用它，且不引入临时输入文件、中央账本或额外运行记录。
- 在仓库的最后一个任务阶段之后，主会话为该仓库的任务范围完成其按仓库交付评审与交付门禁；定稿随后运行单独的定稿评审，不重新评审已交付任务。根前缀交付让同一记录保持 `in-progress` 并带 `root_tasks_commit`，直到 pointer 定稿；仅定稿运行执行零个任务。
- 恢复是有界的：仅在一个干净、已完全检查点的阶段边界或一个已校验的仓库交付边界支持自动继续。肮脏的部分阶段、提交但无检查点的缺口、未知的未来阶段进度、不确定的评审结果、矛盾记录或不相关的目标漂移都会以有界支持或恢复请求停止，而不是重新派发；已记录任务不会被盲目再次派发，丢失的合并完成只在具备确切已评审 head、目标基线、预期合并父提交与已清理证据时被重构。
- 可选的 `workspace_finalization` frontmatter 在子仓库参与计划上声明根所有的定稿覆盖：`requirements` 与 `acceptance_criteria` 与每个任务 AC 不相交，仓库限定的 `read_scope` 条目，不能进入参与仓库的根相对 `write_scope`，以及 `test_commands`。定稿覆盖永不成为任务，也永不加入执行顺序，因此完整计划覆盖是任务覆盖与定稿覆盖的并集，且清单的根子集等于根任务覆盖加上该声明。
- 子仓库参与的 `workspace status` 报告新增 `execution` 投影：从 1 开始的当前父 `phase` 或 `null`、该阶段的 `pending_tasks`（含 `task`、`repo` 与绝对 `repository_path`、`plan_path`）、`awaiting_delivery` 仓库、`blockers` 与 `completed`。既有的 `order` 与 `next_repository` 仍然仅供参考。

## Alternatives considered

- **在每个参与仓库中运行单独的 Coding 会话。** 放弃：这正是本次变更要取代的手动逐子仓库路径，它无法从一处强制冻结的全局阶段或仓库交付屏障，也无法展示依赖方推进之前正确的交付。
- **新增调度服务、嵌套协调者角色或远程 provider 执行器。** 放弃：原生父会话已经是唯一执行者，因此调度器或协调者会增加不受支持的运行时表面和第二个派发真相来源，却不会改进冻结排程。
- **从 `depends_on` 重算全局排程，或让过滤后的切片排程独立推进。** 放弃：冻结的 `tasks/execution-order.yaml` 是唯一的全局排程，重算的 DAG 或切片本地阶段号会让仓库跑在活动父阶段之前并绕过交付屏障。
- **把检查点协议建模为与 Git 的分布式事务。** 放弃：单记录写入器仅面向文件系统，并有意不宣称与 Git 的原子性，因此部分交付会被保留并以其真实状态报告，而不是未实现的回滚保证。
- **把肮脏的部分阶段当作可继续的待办工作。** 放弃：另一个任务未提交的输出与不完整的写入无法区分，因此自动继续仅限于干净且有证据的边界，肮脏情形会以有界支持请求停止。

## Consequences

- 已交付范围由自动化测试覆盖：检查点 CLI 与单仓库兼容性测试（`tests/integration/workspace-checkpoint-cli.test.ts`、`tests/integration/workspace-single-repo-compatibility.test.ts`）、投影单元测试（`tests/unit/workspace-execution.test.ts`）、真实 Git 生命周期与最终树测试（`tests/integration/workspace-coding-git.test.ts`、`tests/integration/workspace-finalization-git.test.ts`）以及已发布内容测试（`tests/behavior/workspace-workflow-content.test.ts`、`tests/behavior/change-routing.test.ts`、`tests/behavior/workspace-planning-content.test.ts`）。这些证明确定性记录与投影行为、被执行的 Git 过程和已发布指令；它们不证明真实模型的原生派发。
- 三主机原生验收在本次运行中没有被完整演示。它需要每个主机——OpenCode、Claude Code 与 Codex——使用一次性夹具和一次性主机 HOME 启动真实的父原生会话，而本次可用运行没有完成该父会话派发冒烟。针对已交付范围，自动化 CLI、真实 Git 与内容覆盖是完整的，但原生父到叶子的工具轨迹仍是一个未决且被明确报告的缺口与阻塞项；不可用的认证或信任不会被转换为通过。
- 本记录部分取代 [子模块工作区交付记录](../architecture/2026-09-30-submodule-workspace.md)、[规划与编码的会话边界记录](../process/2026-09-23-planning-coding-session-boundary.md)、[工作区拆分分发交接记录](../process/2026-10-02-workspace-distribute-handoff.md)、[工作区会话交接记录](../bug-fix/2026-10-08-workspace-session-handoff.md) 与 [工作区执行一致性记录](../bug-fix/2026-10-08-workspace-execution-consistency.md) 中的手动逐仓库会话措辞。每份记录都保留其决定、理由与证据边界，且其当前执行事实指向本记录。
- 普通与仅根条目行为不变：没有 `.gitmodules` 的项目、带 `.gitmodules` 项目中的普通计划，以及仅根条目工作区计划都保持其直接、机械、免拆分或拆分路径、单 worktree 生命周期、记录形态与 CLI 输出，并且不新增子仓库专用工件或命令。
