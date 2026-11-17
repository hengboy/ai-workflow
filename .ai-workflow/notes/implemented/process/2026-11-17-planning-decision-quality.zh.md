# Agent Note: Planning and review decision quality

Status: implemented

[English](2026-11-17-planning-decision-quality.md) | 中文

## Problem

规划本可以问对业务影响问题，却仍冻结出建立在未经审视前提之上的计划：所述请求取代了潜在成果，变更影响保持隐含，主导方案到来时既没有最强反对意见，也没有被考虑过的替代方案。直接缺陷修复也可能只关闭所报告的症状，却留下其成因且没有稳定的回归测试；而 Standards Review 可以评判逻辑、安全、冗余与注释，却对交付代码是否保持可维护一言不发。这些缺口让看似干净的交付携带错误问题、重复缺陷或需要新维护者重建的上下文负担。

## Decision

- 规划从问题框定开始：在澄清循环之前记录所述请求、潜在成果，以及该请求究竟是成果、手段还是症状，并最多提出一次有界、非阻塞的质疑；当该质疑被拒绝或未被采纳时，继续原始请求。
- 计划记录直接与二阶影响及其证据，深度与变更成比例，并记录主导方案及其最强反对意见、回答该反对意见的证据或最终成立的替代方案、每一个被考虑过的实质不同替代方案，以及在不存在实质替代方案时明确声明这一点且绝不虚构。
- 直接缺陷修复用稳定的公共接口回归测试复现缺陷，说明触发条件与成因，修复成因而非症状，并保留该回归测试，不新增评审门禁。
- Standards Review 在既有交付代码判断中加入可维护性视角：令人困惑的命名、隐藏数据流的抽象、不清晰的归属，以及迫使新维护者重建不明显意图的上下文负担。每项发现都要点明精确路径或符号与具体上下文成本，并且除非导致缺陷否则保持 advisory；没有该成本的命名或格式偏好不构成发现。
- 这些规则位于 `templates/skills/planning/SKILL.md`、`templates/skills/planning/references/spec.md`、`templates/skills/planning/references/plan.md`、`templates/agents/spec-review.md`、`templates/skills/coding/SKILL.md`、`templates/agents/standards-review.md`、`templates/project/AGENTS.md` 及其逐字节相同的镜像 `.ai-workflow/AGENTS.md`、`MEMORY.md`、`README.md` 与本记录；不新增任何角色、评审轴、门禁、运行时产物或强制流程步骤。

## Alternatives considered

- **把一组通用推理提示作为新步骤或新门禁加入。** 否决：这会逆转近期的提示精简，重复既有的澄清、评审与笔记机制，并在不改变任何决策的情况下增加审批成本。
- **新增独立的对抗式或回顾式评审能力。** 否决：它重复既有的 Spec Review，且需要独立的有限 Git 历史能力，而每次变更中的规划与评审缺口杠杆更高。
- **在已发布提示中不做任何改动。** 否决：错误问题、症状式修复与未被引用的可维护性缺口确实存在，且只有交付的契约才能留下可评审的证据。

## Consequences

- 规划变更会多出少量承载证据的行与最多一次有界质疑；深度保持成比例，因此有界计划可以用一行说明影响，并明确说明不存在实质替代方案。
- 直接缺陷修复多出一句成因说明与一个保留的回归测试，Standards Review 可以提出绝不会仅因风格偏好而阻塞的可维护性建议；路由、评审触发器、修复预算与评审 packet 保持不变。
- 本记录扩展由 [Standards code review](./2026-11-02-standards-code-review.md) 拥有的可维护性维度、由 [Change routing](./2026-09-22-change-routing.md) 拥有的直接路径、与 [Plan write-scope completeness](./2026-11-16-plan-write-scope-completeness.md) 并列的计划决策内容，以及由 [Review boundaries and repair](./2026-10-14-review-boundaries-and-repair.md) 拥有的路由、修复与集成；它们均未被取代，因此每个独立有用的记录都保持活跃。
- 验证是静态的 shipped-content 证据而非真实模型行为：决策质量行为测试、逐字节相同的契约镜像比较，以及笔记与上下文验证门禁全部通过。
