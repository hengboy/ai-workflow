# Agent Note: 特性优先的分流与工作树集成

Status: implemented

[English](2026-11-03-routing-and-worktree-merge.md) | 中文

## Problem

先前的分流规则规定，只要意图清晰、边界明确且只有一个可观察结果，小范围的新能力就可以走 Direct 路径，因此新的用户可见功能可以仅凭规模判断跳过 Planning 与双轴评审。工作树规则只说明临时分支与所属工作树合并回主线，冲突规则则在任何冲突时停止运行且不自动解决。于是 Direct 或 Mechanical 变更没有记录下来的集成目标，交付前普通的目标分支推进也可能被误认为源漂移或被当作无法解决的冲突。

## Decision

- 每个请求仍在动手前用一行分类，且分类仍是唯一的例行评审触发器。新功能或用户可见能力始终是 Planned 变更，即使其范围看起来很小或只有一个可观察结果。
- Direct 仅限于对既有行为的有界调整或缺陷修复，要求意图清晰、只有一个可观察结果，且不新增任何用户可见能力。Mechanical 仍是错别字、文案、注释、格式或纯测试调整，无可观察行为变化。
- Direct 与 Mechanical 仍执行完整编码单元并保留强制性的项目内临时工作树 `<project>/.worktrees/<name>`：实现、验证与提交都在其中完成，结果合并回记录的目标分支。只跳过 Planning 产物与双轴评审。
- 创建工作树时，Git Operator 记录当时检出的分支及其起始提交作为集成目标。游离的起始检出没有目标分支，因此在实现前以有界支持请求停止。
- 集成是把工作树分支非快进合并进该记录的目标分支，交付合并 SHA 与已接受的源 HEAD 分开记录。当源 HEAD、仓库与工作树身份仍与已接受证据一致时，目标分支推进不算源漂移；源 HEAD 被移动或变脏仍拒绝集成。
- 发生合并冲突时，Git Operator 通过保留双方改动来调和每个冲突块，绝不整体选择 ours 或 theirs，也绝不 rebase、force、reset 或 amend；解决后重跑受影响的检查。若双方无法同时保留，或解决后检查失败，只中止进行中的合并，保留所属工作树与分支，并以被阻塞状态报告冲突路径、解决证据与失败的检查。
- 工作区的仓库交付遵循同样的记录目标与双方保留策略，其已评审提交仍是已评审的源 HEAD。该策略陈述于 `templates/project/AGENTS.md` 及其逐字节相同的镜像 `.ai-workflow/AGENTS.md`、`templates/skills/coding/SKILL.md`、`templates/skills/coding/references/workspace.md`、`templates/skills/planning/SKILL.md`、`templates/agents/git-operator.md` 与 `README.md`。

## Alternatives considered

- **让 Direct 继续对小范围新能力开放。** 放弃：原规则让新的用户可见功能仅凭有界范围判断就跳过 Planning，而这正是本策略消除的分类歧义。
- **继续在任何冲突时停止。** 放弃：它会丢弃本可解决的交付，并把普通的目标分支并发工作变成死路；保留双方并重跑既保留双方行为，又在无法保留时仍然阻塞。
- **通过整体选择一方或 rebase 来解决冲突。** 放弃：整体选择会静默丢弃另一方的已交付行为，而 rebase、force、reset 或 amend 会改写已接受的历史。
- **把任何目标分支推进都视为源漂移。** 放弃：拒绝已推进的目标会阻断普通的并发工作，而真正必须一致的是已接受的源 HEAD、仓库与工作树身份。
- **把自动冲突解决当作一次新的语义评审。** 放弃：解决属于集成证据而不是第二次评审，因此宣称合并结果已通过评审会夸大双轴评审实际判断的内容。

## Consequences

- Direct 范围被收窄：新增用户可见能力的请求即使很小也进入 Planning，而对既有行为的有界调整与缺陷修复保留直通路径。
- Mechanical 路径不变：错别字、文案、注释、格式或纯测试调整仍只运行最窄的相关检查。
- Direct 与 Mechanical 变更仍保留工作树、提交与合并成本，因此本次变更消除的是分类与集成的歧义，而不是执行开销。
- 阻塞恢复是显式的：无法解决的冲突或解决后检查失败会保留所属工作树与分支，不提交冲突标记或不完整解决，并报告冲突路径、解决证据与失败的检查。
- `tests/behavior/change-routing.test.ts`、`tests/behavior/worktree-policy.test.ts`、`tests/behavior/coding-v2-content.test.ts` 与 `tests/behavior/workspace-workflow-content.test.ts` 的静态内容测试守护特性优先分类、保留的工作树与合并回、记录的目标、双方保留解决、受影响检查重跑、阻塞处理、旧“遇冲突即停止”指令的缺席以及工作区一致性。这是静态 shipped-content 证据，不声称真实模型合规。
- 没有运行时分类器、schema 字段、CLI 命令或持久化格式变化，既有任务、工作区与实施记录形态保持兼容。
- [变更分流](./2026-09-22-change-routing.md) 被部分取代：其 Direct 定义由特性优先分类替代，而其分流理由、备选方案与后果仍然现行。[项目内工作树策略](./2026-09-14-project-local-worktree-policy.md) 同样被部分取代：其主线合并回措辞由记录下来的集成目标与双方保留冲突策略替代，而其强制工作树决定、备选方案与后果仍然现行。
