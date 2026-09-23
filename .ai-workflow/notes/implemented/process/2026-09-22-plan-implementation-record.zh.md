# Agent Note: 计划实施记录

Status: implemented

[English](2026-09-22-plan-implementation-record.md) | 中文

## Problem

此前编码执行没有留下最小记录，说明某个冻结计划是否已实施、何时开始、何时结束。治理文本无例外地禁止一切 workflow manifest 与运行记录，因此维护者无法区分已完成的实施与开始后未完成的实施，也无法从单个文件获知运行的开始与结束时间。[worktree 策略记录](./2026-09-14-project-local-worktree-policy.md)中的项目本地 worktree 策略与[忽略状态共享记录](./2026-09-14-share-ignored-state-into-worktree.md)中的忽略状态共享规则，已经让 `.ai-workflow/plans/` 在项目根保持可见且单一来源，但该边界下没有任何被允许的文件承载实施时间。

## Decision

- 唯一被允许的运行记录是 `<project>/.ai-workflow/plans/<planId>/implementation.yaml`。写入归属仍属于 `coding` 编排器，worktree 物化归属仍属于 `git-operator`，治理文本归属仍属于 `documentation-maintainer`；文件边界始终解析到项目根，并保持为 gitignored 本地状态。
- 在第一个实施步骤之前，该文件持有 `plan_id`、`status: in-progress` 与 ISO 8601 的 `started_at`，且不含 `completed_at`。
- 在最终合并与仅清理运行拥有的 worktree 和分支之后，同一文件变为 `status: completed`，带有 ISO 8601 的 `completed_at` 与最终 commit SHA，并保留 `plan_id` 与 `started_at`。该更新是幂等的；当开始记录缺失时，仍写入省略 `started_at` 的有效完成记录。
- 该记录只有 `in-progress` 与 `completed` 两个状态值。中断的运行停留在 `status: in-progress`，仅保留开始字段，绝不写入失败或放弃原因。只有冻结计划才会创建该记录；没有冻结计划的小修复不创建任何记录。
- 该标准由 `templates/skills/coding/SKILL.md` 中的 `coding` 技能、`templates/project/AGENTS.md` 与 `.ai-workflow/AGENTS.md` 中的项目契约、`templates/project/MEMORY.md` 与 `MEMORY.md` 中的项目记忆以及 `README.md` 共同陈述。不得生成任何其他 workflow manifest 或运行记录，`ai-workflow plan validate` 与 `ai-workflow plan pairing` 既不要求也不读取 `implementation.yaml`。

## Alternatives considered

- **写入按步骤或按任务的进度日志，并附带失败原因与耗时。** 放弃：已批准范围只需要维护者一眼可读的一个最小时间记录，而运行日志会重新引入禁令本想消除的运行记录面。
- **为该记录新增 CLI 子命令、schema 或迁移。** 放弃：当记录只是现有读取器忽略的纯本地状态时，不需要新命令或新格式；保持 `ai-workflow plan validate` 与 `ai-workflow plan pairing` 不变可以避免兼容性面。
- **为该记录配 `.zh.md` 与 `.i18n.yaml` 同级文件，并要求计划校验读取它。** 放弃：该记录不是规划产物，把同级文件或校验变成强制要求，会把本地运行时元数据变成冻结的规划门禁。
- **为历史计划与没有冻结计划的小修复补写记录。** 放弃：没有观测到的开始与完成时间无法如实重建，而未经规划的修复没有可记录的冻结 `plan_id`。
- **增加终止态的失败或放弃状态。** 放弃：中断的运行有意与未完成的运行不可区分，因此 `in-progress` 仍是唯一的非终止状态，之后成功的运行只需把同一路径重写为完成态。

## Consequences

- 维护者只需读取 `<project>/.ai-workflow/plans/<planId>/implementation.yaml` 这一个文件，即可判断某个计划是否已实施、何时开始、何时结束，无需查阅按步骤的过程日志。
- 编码保留全面禁令并只开一个豁免：该 `implementation.yaml` 是唯一被允许的运行记录，因此任何额外的 manifest 或运行记录仍属违规。
- 中断的工作绝不写入失败态，这保持了文件的如实性，但意味着中断原因必须到该记录之外查找。
- 已安装的宿主技能与代理只有在下一次宿主安装或 profile 激活后才会获得新文本，因此运行时记录是在 rollout 之后下一次真实实施中被观察到，而不是由本计划自身产生。
- 没有任何 active note 被全部或部分取代：[worktree 策略记录](./2026-09-14-project-local-worktree-policy.md)、[忽略状态共享记录](./2026-09-14-share-ignored-state-into-worktree.md)与[项目契约与 Agent Notes 替代记录](./2026-09-16-project-contract-and-agent-notes.md)仍然有效，本记录只增加了它们此前未允许的唯一豁免。
