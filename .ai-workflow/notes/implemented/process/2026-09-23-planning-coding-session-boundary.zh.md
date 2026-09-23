# Agent Note: 规划与编码的会话边界

Status: implemented

[English](2026-09-23-planning-coding-session-boundary.md) | 中文

## Problem

[变更分流](./2026-09-22-change-routing.md)为 planned change 提供了先规划再实施的路径，但没有说明当会话发现计划缺失时应该在哪里停下。`coding` 技能的 planned change 条目与其自动续跑规则连起来读就是一次连续运行——分类、规划、实施——因此中途进入 Planning 的会话可能从已校验的 `spec.md` 与 `plan.md` 直接进入实施，而用户并未显式发起一次编码运行。

## Decision

- 当 `coding` 会话把请求分类为 planned change 且不存在冻结计划时，会话先运行 Planning，并在冻结计划通过其校验门禁后停止。
- 交接时报告冻结计划的路径，并提示用户在新会话中调用 coding 技能来实施。
- 规划会话不创建任何实施状态：不创建 worktree，不创建 `implementation.yaml`，不派发实施或评审，也不提交。
- `planning` 技能的完成清单携带同样的交接，因此直接调用的 Planning 运行也在冻结计划处结束，而不是开始实施。
- `tests/behavior/change-routing.test.ts` 守护 `coding` 与 `planning` 的已发布文本以及 README 句子，若重新把 Planning 接回自动实施，测试套件会失败。

## Alternatives considered

- **规划完成后在同一会话继续实施。** 放弃：边界正是本次要求的行为；冻结计划是一份全新输入，应该在新会话中开始，而不是悄悄延续规划上下文。
- **规划完成后停止但不给交接指令。** 放弃：结束回合却不给下一步，用户就缺少必需的动作；交接会给出冻结计划路径与 coding 技能。
- **依赖 planning 技能已有的“不得调用编码工作流”禁令。** 放弃：该禁令约束的是 Planning 自身动作，而不是 coding 技能的续跑调度，coding 会话仍可能把自己的派发计划带过边界。

## Consequences

- 在 coding 会话中发现的 planned change 现在会产出一份冻结且已校验的计划并停在那里；实施只在新会话中恢复，冻结计划就是边界。
- [变更分流](./2026-09-22-change-routing.md)仍负责 direct、mechanical 与 planned 的分类；本记录只补上 Planning 到 Coding 的交接。
- [项目契约与 Agent Notes 记录](./2026-09-16-project-contract-and-agent-notes.md)仍然有效；没有活动记录被取代。
