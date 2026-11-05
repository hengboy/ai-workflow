# Agent Note: 标准代码评审

Status: implemented

[English](2026-11-02-standards-code-review.md) | 中文

## Problem

已发布的 Standards Review 检查 MEMORY 与笔记合规性，却不评判交付的代码本身。一个规划实施可以在两个评审轴上都通过，却带有逻辑漏洞、未处理的边界、未被解释的安全暴露或新引入的冗余，因为 Spec Review 只关注需求，且没有任何轴负责交付代码质量。加入该判断需要一个归属，同时保持既有评审路由、触发器、轴、角色数量与只读边界，而不是另建一条平行评审路径。

## Decision

发现门槛由 [Review evidence and shared skills](2026-11-05-review-evidence-and-shared-skills.md) 细化；本记录保留评审轴归属、维度及历史验证理由。

- 交付代码质量评审属于既有的第二个（Standards）轴：Standards Review 保留其对 MEMORY 与笔记一致性的职责并加入代码判断，因此评审路由、变更类别触发器、两个轴与角色数量保持不变，且不存在新角色或第三个轴。
- 该轴在所提供的不可变范围内判断三个维度：逻辑与边界正确性；带有书面风险说明的安全风险；以及冗余加关键注释质量。
- 严重性映射到受支持用法的可达性：逻辑或边界发现须具备具体可达触发条件，且预期行为来自公开契约、已记录用法、不变量或必需标准；可达的不正确行为、未处理边界、状态损坏或资源泄漏即使罕见仍属于 error。安全错误要求实际信任边界下可合理利用、提升权限或泄露数据的风险；推测性或不可达顾虑不构成可执行发现，缺少必需证据时提出有界支持请求。冗余或关键注释发现保持 advisory，除非导致缺陷。
- 冗余发现仅限于被评审变更所引入的代码，并提出最小的保持行为不变的简化；关键注释发现指出不明显的逻辑以及需要记录的持久行为或理由，绝不使用临时的计划内部标识符。
- 评审保持有界且只读：它只读取 packet 授权的路径、所提供的 diff、同一不可变范围内的有界源码上下文、MEMORY 与所提供的证据，且绝不搜索、运行 Git 或测试、编辑文件、臆造需求或报告未被引用的风格偏好。
- 该策略发布在 Standards Review 角色模板、项目契约及其逐字节相同的受跟踪镜像、coding 技能、README 与 MEMORY 中，并由 `tests/behavior/review-policy.test.ts` 守护。

## Alternatives considered

- **为代码质量新增第三个评审角色或轴。** 放弃：既有的 Standards 轴已经负责依据项目标准评判交付内容，而新增一个轴会改变评审路由、批次组成与角色数量，却不增加独立的决策。
- **把每一项冗余或关键注释发现都设为阻塞项。** 放弃：这类发现大多不改变行为，因此以此阻塞会把建议性清理变成合并风险；它们保持 advisory，除非导致缺陷。
- **把交付代码评审并入只关注需求的 Spec Review。** 放弃：Spec Review 在不可变范围上评判冻结需求与验收标准，且必须保持独立于实现质量，因此在那里做代码判断会模糊轴分离与各自独立的载荷。

## Consequences

- 三个维度与严重性语义现在一致地陈述于 `templates/agents/standards-review.md`、`templates/project/AGENTS.md` 及其逐字节相同的镜像 `.ai-workflow/AGENTS.md`、`templates/skills/coding/SKILL.md`、`README.md` 与 `MEMORY.md`，并由 `tests/behavior/review-policy.test.ts` 守护。
- 验证证据是静态的 shipped-content 证据，而非真实模型行为：镜像比较退出码为 0，针对 `tests/behavior/review-policy.test.ts`、`tests/behavior/notes-content.test.ts`、`tests/behavior/coding-v2-content.test.ts` 与 `tests/integration/global-agent-guidance.test.ts` 的定向批次退出码为 0，共 105 项测试。产品提交为 `5c0bda37bfa261d61b65da269a65e4754226e540`。
- 路由保持不变：Direct 与 Mechanical 变更不派发任何轴，Planning 只派发 Spec Review，plan-to-tasks 两者都不派发，普通规划实施保持一次并行的完整 Spec 与 Standards 批次；已安装宿主在下一次安装或升级时获得更新后的检查清单。
- [评审边界与修复](./2026-10-14-review-boundaries-and-repair.md) 保留其路由、聚合修复、复核与集成理由；本记录补充交付的代码质量判断，且不取代该记录。
