# Agent Note: 变更分流

Status: implemented

[English](2026-09-22-change-routing.md) | 中文

## Problem

流程没有显式的分流规则，因此任何请求都可能看起来像规划候选。`coding` 技能要求已批准的任务，其前置条件会读取冻结的 `spec.md` 与 `plan.md`；`planning` 技能没有陈述进入条件；项目契约只描述了规划流程。因此，一个小的前端样式改动连同配套测试更新也会提示走 Planning 与双轴评审，尽管没有任何需求需要澄清，也不存在 spec。小需求、功能调整与缺陷修复没有可达的直通路径，而[worktree 策略记录](./2026-09-14-project-local-worktree-policy.md)又让每个编码单元无论风险都要付出其执行成本。

## Decision

- `templates/project/AGENTS.md` 与 `.ai-workflow/AGENTS.md` 中的项目契约新增 Change routing 一节：每个请求在开始动手前先分类，分类决定工作流。
- Direct change：意图清晰、边界小且只有一个可观察结果的小需求、功能调整或缺陷修复，直接实施，不进入 Planning，不产出 `spec.md`、`plan.md` 或任务文件，也不派双轴评审；运行相关检查，缺陷补一个聚焦的回归测试。
- Mechanical change：错别字、文案、注释、格式或纯测试调整且无可观察行为变化，只运行最窄的相关检查。
- Planned change：新功能、含糊或有争议的需求、存在多种实质不同设计，或触碰公共接口、持久化格式、跨模块或跨栈行为、迁移、兼容性、项目契约的改动，先运行 Planning，并保留双轴评审门禁。
- `coding` 技能的描述与其 Codex 目录元数据去掉“已批准任务”的措辞，保留 worktree 与 Git Operator 执行单元，在开始处记录分类，并声明 direct 或 mechanical 改动不创建实施记录；`planning` 技能的描述与正文把 Planning 限制在 planned change，并禁止复述已定型的请求。
- `tests/behavior/change-routing.test.ts` 守护已发布的契约、技能描述、元数据、记忆模板与 README 文本，未来若重新引入“已批准任务”偏向，测试套件会失败。

## Alternatives considered

- **保留隐含行为，依赖代理自行判断。** 放弃：实际结果是清晰的微小修复被导向 Planning，因为已发布的描述与前置条件没有提供直通路径。
- **按文件数量或 diff 大小分流。** 放弃：影响范围是结果而不是标准；一行公共接口改动需要 Planning，而多文件文案改动不需要。
- **为 direct 改动放宽 worktree 与 Git Operator 执行单元。** 放弃：所报告的负担是 Planning 与双轴评审，保留 Git 单一入口可以维持既有不变量。
- **对非常简单的改动完全跳过验证。** 放弃：即使 mechanical 改动也保留最窄的相关检查，绝不弱化测试仍是强制要求。

## Consequences

- 小需求、功能调整或缺陷修复不再提示 Planning，而是直接实施并运行相关检查。
- 每个请求都有明确的分类，代理若把小改动导向 Planning、或把该规划的改动标为 direct，都会与已发布文本相矛盾。
- Direct 与 mechanical 改动仍会创建 worktree 并通过 Git Operator 提交，因此本次变更降低的是规划与评审开销，而不是执行开销。
- [实施记录](./2026-09-22-plan-implementation-record.md)与[worktree 策略记录](./2026-09-14-project-local-worktree-policy.md)仍然有效；没有活动记录被取代，本记录只补上缺失的分类。
