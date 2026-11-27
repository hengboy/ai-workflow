# Agent Note: 作为只读可观测性与 DAG 验证任务的 Swarm 原则

Status: implemented

[English](2026-11-27-swarm-principles-observability-and-verification-tasks.md) | 中文

## Problem

拆分计划本可以并行运行任务，但没有任何内容报告其调度实际使用了多少并行度，也没有报告评审、修复与集成工作需要多少成本。操作者在比较串行调度与并行调度，或比较有无独立验证的并行边界时，没有确定性的只读证据，因此诱人的补救办法是引入第二套编排运行时，自带协调者、共享看板与按 worker 划分的 worktree。

## Decision

- 静态调度效率以只读方式暴露：`parallel_width`（最宽的调度阶段）、`critical_path_ratio`（`critical_path_length / task_count`）与 `estimated_parallel_speedup`（`task_count / critical_path_length`）加入 `plan validate` 与 `plan report` 报告的计划指标。两个比率四舍五入到四位小数，并在分母缺失时报告 `0`，因此没有任务或没有关键路径的计划不会产生 `NaN` 或 `Infinity`。
- 两条建议性 `plan lint` 警告指向 `plan.md`：当至少三个任务逐个串行运行且关键路径比率达到 `0.8` 时给出一条 `plan-schedule-serial`；当某个并行实现阶段没有任何严格更晚的 `surface: test` 任务通过依赖该阶段至少两个实现任务来覆盖时，给出一条去重的 `parallel-tasks-without-integration-verify` 并列出这些阶段。Lint 在存在有效冻结 `tasks/execution-order.yaml` 时读取它，否则回退到只读的 `depends_on` 深度分组；该分组忽略未知 ID，并在存在环时跳过这两条警告；两条警告都不改变 `plan validate`、退出码或门禁。
- 边界证据通过一条白名单命令记录：`ai-workflow execution event <type> --plan <directory> [--result <value>] [--boundary <name>]`，仅接受 `review.started`、`review.completed`、`repair.completed` 与 `validation.completed`。它要求运行状态为运行中，修剪并校验两个值，要求 `validation.completed` 携带结果，只存储 `result` 与 `boundary` 载荷键，对无效请求以退出码 1 且零写入拒绝，并把存储失败报告为退出码 0、`event_id: null` 与一条警告，同时 `implementation.yaml` 保持字节不变。
- `execution analytics` 新增 `phase_wall_clock`、`review_duration_seconds`、`repair_rounds`、`integration_failure_rate` 与 `cost_per_accepted_task`。每个值都只来自已存储的运行、事件与冻结调度数据，工作区切片在某个阶段只统计本仓库的任务，缺失证据报告 `N/A` 或 `0`，而不是负数或虚构值。
- 验证是冻结图中的任务。当并行实施步骤共享跨任务集成边界时，Planning 要求一个下游 `test` 验证步骤，并在写清单中声明确切的集成测试写路径；plan-to-tasks 则派生一个下游 `surface: test` 任务，其 `depends_on` 指名被验证的实施任务，其 `write_scope` 只包含冻结的测试路径，其 `test_commands` 证明共享边界。
- 执行模型在其他方面不变：单一 worktree、冻结阶段调度、串行任务提交与最终双轴评审。验证不新增角色、Board、按阶段评审触发或门禁。
- 结构性成本约束保持明确：不发起模型调用、不发起网络调用、不做周期性扫描、不记录提示词、推理或工具调用载荷，且查询只读。

## Alternatives considered

- **带协调者、共享看板、动态分解与按 worker worktree 的完整 Swarm 运行时。** 已否决：它与单一 worktree、冻结调度、串行提交与双轴评审决定冲突，并把低成本的串行集成替换为多分支冲突解决。
- **没有边界记录器的只读分析。** 已否决：`review_duration_seconds` 与修复前的 `integration_failure_rate` 在单仓库运行上会永久停留在 `N/A`。
- **四个独立的 `execution` 事件子命令。** 已否决：一条白名单命令让 CLI 及其校验面保持最小。
- **在 `plan validate` 中强制要求下游验证任务。** 已否决：只有当避免的返工超过验证成本时验证才划算，因此建议性 lint 警告可避免独立任务上的冗余测试。

## Consequences

- 操作者无需第二套运行时即可从确定性只读输出比较调度效率与返工成本，且每个新值都是增量式的，并对旧计划、运行与事件提供 `N/A` 或 `0` 回退。
- 边界写入缺失、延迟或失败会把分析降级为 `N/A` 与一条可见警告；它绝不阻塞运行，也绝不改写权威实施记录。
- 验证新增提示词文本与一个被调度的测试任务，绝不新增角色或评审触发；没有共享边界的并行组不会获得名义上的验证任务。
- 无取代：[计划写作用域完整性记录](2026-11-16-plan-write-scope-completeness.md)保留其确切清单、派生作用域与修订决定，验证任务的 `write_scope` 派生自同一冻结清单；[任务执行顺序记录](2026-09-25-task-execution-order.md)保留其冻结调度、不回退与单一 worktree 决定，验证任务由相同的阶段派生调度。
- 边界记录器与新分析扩展[执行可观测性记录](../architecture/2026-11-17-execution-observability-resilience.md)而不取代它：该记录保留程序拥有的叠加层、权威记录与成本约束。
- 在以下情况下重新评估：测量比较显示建议性警告无法区分有用的串行调度；有答复的评审延迟与集成失败数据使边界记录器变得多余；或第二套运行时能够保持单一 worktree、串行提交与双轴评审保证。
