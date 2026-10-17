# Agent Note: 规划后自动拆分分发

Status: implemented

[English](2026-10-15-post-planning-auto-split-distribution.md) | 中文

## Problem

子仓库参与的工作区计划在缺少额外手动步骤的情况下无法进入实施。Planning 冻结 `spec.md` 与 `plan.md` 之后，规划会话停在冻结计划处，告知用户在工作区根启动新会话，但没有任何环节调用 plan-to-tasks、校验拆分、分发切片或声明任务集已冻结。因此用户可能拿到一份没有可执行任务集的冻结计划，编码会话只能到那时才运行准备，或拒绝未分发的计划。所要求的行为是一条规划后的自动链，最终得到已冻结、已分发的任务集。

## Decision

- 冻结的一对文件通过 `ai-workflow plan validate --plan <directory>` 之后，对于 `plan.md` 声明 `workspace_repos` 且包含至少一个参与的非根仓库的计划，规划会话立即在同一会话中用绝对父计划目录自动调用 plan-to-tasks 准备流程；它不启动任何额外会话、兄弟进程或 provider API。
- 该链式流程在写入任何任务工件、排程、`workspace.yaml` 或切片之前展示完整批准预览并请求显式批准，且拒绝批准不会创建任何任务、切片、分发或实施提示。
- 批准之后，它写出完整任务三元组及其配对记录、`tasks/execution-order.yaml` 与 `workspace.yaml`，通过最终的 `ai-workflow plan validate --plan <directory>`，为每个参与仓库运行 `ai-workflow workspace distribute --plan <directory>`，并要求 `ai-workflow workspace status --plan <directory>` 报告 valid 且每个参与切片均 present。
- 可执行任务集只有在上述完整分发对每个参与仓库都成功之后才被冻结；在此之前拆分会话声明任务集未冻结、不声明完成也不启动任何实施状态，并且拒绝或不完整的分发会保留已写出的工件，用 `ai-workflow plan pairing --plan <directory> --write --all` 重新配对记录、用 `ai-workflow plan validate --plan <directory>` 重新校验并重跑，绝不重新生成。
- 冻结之后，会话报告每个参与仓库的 name、path、`depends_on` 与切片状态以及冻结的交付顺序，然后告知用户在工作区根启动新会话，用绝对冻结计划目录调用 coding 技能来实施冻结计划；编码会话在任何 worktree 或实施记录之前先校验交付门禁，并在不重复拆分或分发的情况下实施。
- 普通计划、`workspace_repos` 只声明保留 `workspace` 根条目的仅根条目工作区计划，以及没有 `.gitmodules` 的项目保持其现有路径，且独立调用 plan-to-tasks 以及编码会话针对没有任务集或不完整切片的计划的有界恢复准备仍然保留。

## Alternatives considered

- **在新的编码会话中保留拆分。** 放弃：它使所要求的规划后自动链未能实现，并且仍然要求用户在任务集存在之前启动一个单独的会话。
- **把 spec/plan 冻结移到分发之后。** 放弃：它颠倒了冻结输入的依赖，因为分发消费的是冻结的一对文件，并且会使切片字节与已分发的计划产生分歧。

## Consequences

- 该规则作为提示指引发布在 `templates/skills/planning/SKILL.md`、`templates/skills/plan-to-tasks/SKILL.md`、`templates/skills/coding/SKILL.md` 与 `templates/skills/coding/references/workspace.md`、`templates/project/AGENTS.md` 与 `.ai-workflow/AGENTS.md`、`README.md`、根 `MEMORY.md` 以及权威 navigation 中，因此不引入任何 schema、配置、状态或数据迁移。
- `tests/behavior/workspace-planning-content.test.ts`、`tests/behavior/change-routing.test.ts` 与 `tests/behavior/workspace-workflow-content.test.ts` 中的聚焦已发布内容测试锁定该链式流程、冻结门禁以及不变的普通、仅根条目与非 `.gitmodules` 路径；它们证明的是已发布的提示指引，而不是主机运行时强制。
- 更早的、本应在分发之后才冻结任务集的规划边界被取代并在本次交付前删除，其被接受的冻结门禁语义并入本记录。
- 本记录部分取代 [规划与编码的会话边界记录](./2026-09-23-planning-coding-session-boundary.md)、[工作区拆分分发交接记录](./2026-10-02-workspace-distribute-handoff.md)、[工作区会话交接记录](../bug-fix/2026-10-08-workspace-session-handoff.md) 与 [工作区编码编排记录](../feature/2026-10-09-workspace-coding-orchestration.md) 中的交接事实；每份记录都保留其决定、理由与证据边界，且其当前交接事实指向本记录。
