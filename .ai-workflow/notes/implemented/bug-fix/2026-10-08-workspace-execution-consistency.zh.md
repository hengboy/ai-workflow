# Agent Note: 工作区执行一致性：状态、就绪判定与根任务交付

Status: implemented

[English](2026-10-08-workspace-execution-consistency.md) | 中文

## Problem

`ai-workflow workspace status --plan <directory>` 仅仅因为计划与 `workspace.yaml` 清单能够解析就报告 `valid: true`，而没有把清单对照冻结的计划、任务集与排程进行校验。它的 `next_repository` 遵循 `workspace.yaml` 清单数组且只覆盖非根仓库，因此既无法表达冻结交付顺序，也无法表达待交付的根任务集。`workspace_root_entry` 只暴露 `record`，根拥有的任务交付没有任何表示，而就绪判定仅针对子仓库，于是报告中没有任何信息能说明根前缀是否已交付。`git-operator` 角色仍在描述隔离的任务 worktree 与任务提交合并，与 coding 技能使用的单 worktree 串行提交执行相矛盾。

## Decision

- `ai-workflow workspace status --plan <directory>` 在报告 `valid: true` 之前，先对照冻结的计划、任务集与 `tasks/execution-order.yaml` 校验工作区清单；清单有分歧时以错误失败且不改变任何字节。
- 报告的 `order` 与 `next_repository` 遵循冻结 `tasks/execution-order.yaml` 中仓库首次出现的顺序，并在其任务待交付时包含保留的 `workspace` 根条目，绝不遵循 `workspace.yaml` 清单数组顺序。
- `workspace_root_entry` 携带 `record`、`tasks_delivered` 以及可为空的 `delivery_commit`；当根本身不拥有任务、或其记录已携带已交付提交时，`tasks_delivered` 为 true。
- 根拥有的任务以同一个根 `implementation.yaml` 中可选的 `root_tasks_commit` 交付，它是完整的小写 40 或 64 位十六进制提交 SHA；有效的 `root_tasks_commit` 优先于已完成根记录的 `commit` 回退，作为根交付证据，且 `workspace status` 只检查其语法，Git 在最终门禁验证对象。根前缀合并且其拥有的 worktree 被清理之后，该记录保持 `status: in-progress` 并带 `root_tasks_commit`，不含 `completed_at` 或 `commit`，并持续到最后一次 pointer 定稿。仅定稿的运行执行零个任务，跳过已交付的根任务且不再重新评审它们，保留 `started_at` 与 `root_tasks_commit`，并且只有到那时才把记录改写为 `completed`，带 `completed_at` 与最终提交；被中断的定稿保留 `root_tasks_commit`。工作流仍然只有一条记录，且只有 `in-progress` 与 `completed`。
- 子记录只有在 `record` 为 `completed`、其 `slice` 为 `present`、其 `plan_id` 与冻结计划匹配、且其 `delivery_commit` 是完整提交 SHA 时才算交付。`ready_for_finalization` 把每个这样的子仓库与根 `tasks_delivered` 结合起来。
- 就绪判定仍只是文件系统证据：根 Git Operator 在任何索引改动之前，用只读的 `git cat-file -e <sha>^{commit}` 存在性检查校验每个交付 SHA，而对象存在并不等于 ref 可达。`workspace status` 不运行 Git。
- Git Operator 对所有任务使用单个 `<project>/.worktrees/<name>` worktree，并串行提交每个任务的写入范围，不存在按任务划分的 worktree。
- Planning 把保留的 `workspace` 根保持为无依赖的 `prefix`，其任务与定稿分开交付；`src/workflow/parse.ts` 中的冻结校验强制根 `depends_on` 为空并拒绝非空值，由 `tests/integration/plan-workspace-cli.test.ts` 守护。它要求跨仓库验收标准指明其归属仓库并给出精确、有界的只读源检查；绝不自动 checkout 子仓库；根拥有的笔记与子仓库交付事实保持分离。
- `README.md`、`MEMORY.md`、项目契约以及受影响的笔记陈述相同的事实。

## Alternatives considered

- **为根交付新增第三个状态值或单独的根记录文件。** 放弃：一个冻结计划就是一次运行、一条记录，因此第三个状态或第二个文件会破坏两状态、一记录的不变量，并迫使每个读取者学习新形态。
- **保持就绪判定仅针对子仓库，把根任务交付留给调用方。** 放弃：就绪门禁届时会依赖带外知识，并可能在根前缀从未交付时钉住工作区。
- **保持 `next_repository` 按清单排序且仅针对子仓库。** 放弃：清单数组顺序不是冻结交付顺序，且忽略待交付的根任务，因此交接或定稿会落在错误位置。
- **用 ref 可达性而非对象存在性校验交付 SHA。** 放弃：钉住边界与 Git Operator 契约在任何索引改动之前使用 `cat-file` 存在性，采用可达性策略会改变该边界，而不是记录它。
- **从发现结果重建整个 navigation 索引。** 放弃：本仓库带有宽泛的自动发现特性（`root`、`src`、`tests`），发现式重建会替换精选索引，而不是加入这些事实。

## Consequences

- 状态报告、就绪门禁与单记录根交付现在在 `README.md`、`MEMORY.md`、项目契约与已发布技能之间保持一致。
- `workspace status` 保持仅文件系统，并且现在对分歧的清单采取失败关闭，因此不匹配的 `workspace.yaml` 不再可能看起来就绪。
- `root_tasks_commit` 是完整的小写 40 或 64 位十六进制 SHA，只出现在根 `implementation.yaml` 中，只有根工作区会话写入它，并且优先于已完成的根 `commit` 作为根交付证据；子记录保持现有形态，而保留根的 `workspace_root_entry` 新增 `tasks_delivered` 与 `delivery_commit`。
- 本记录部分取代 [工作区会话交接记录](./2026-10-08-workspace-session-handoff.md) 中仅针对子仓库的就绪与仅作参考的 `next_repository` 事实、[工作区拆分分发交接记录](../process/2026-10-02-workspace-distribute-handoff.md) 中的当前 `workspace status` 事实，以及 [子模块工作区交付记录](../architecture/2026-09-30-submodule-workspace.md) 中的 `workspace status` 与根交付事实，并为 [计划实施记录](../process/2026-09-22-plan-implementation-record.md) 增加根交付阶段；每份记录都保留其决定、理由与历史，且其当前事实指向本记录。
- 执行由 `tests/integration/workspace-status-cli.test.ts`、`tests/integration/workspace-finalization-git.test.ts`、`tests/integration/plan-workspace-cli.test.ts`、`tests/behavior/worktree-policy.test.ts` 与 `tests/behavior/implementation-record.test.ts` 守护；证据范围是已发布文本、CLI 状态用例与定稿 Git 守卫，而不是真实运行的 agent 工作流。

