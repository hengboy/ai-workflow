# Agent Note: 评审边界与修复

Status: implemented

[English](2026-10-14-review-boundaries-and-repair.md) | 中文

## Problem

已发布的工作流让评审的触发与收尾都处于不确定状态。项目契约描述了双轴评审，却保留了未定义的 larger 或 high-risk 触发器，且 `coding` 仍要求用户在"只修选定项"与"修复全部发现"之间做选择后才合并。规划在取得批准之后才运行 Spec Review，并可能在出现范围内错误后再次要求批准。没有任何边界允许在一次聚合修复之后只对受影响的单一轴做定向复核，评审角色禁止任何第二次评审（包括发现复核），Git Operator 也没有在非快进合并之前进行已接受来源 HEAD 的比较。执行 Status 可能被读作验收裁决，而未达成的验收标准、被引用的必需标准违规或不可用的必需证据都没有明确的阻塞语义。这些缺口使评审批次不确定、强制出常规的选择提示，并让收尾证据可以从一次成功的检查点或 `done` 状态推断出来。

## Decision

- 项目契约 `templates/project/AGENTS.md` 及其纳入版本控制的镜像 `.ai-workflow/AGENTS.md` 新增 `## Review policy` 一节，MEMORY、README 与本记录描述同一策略：变更类别是唯一常规评审批次触发条件。
- Direct 与 Mechanical 变更不派发任何评审轴，Planning 只派发 Spec Review 而绝不派发 Standards Review，plan-to-tasks 两者都不派发；普通规划实施无论拆分与否，都在实施及其必需检查之后、集成之前运行一次并行的完整 Spec Review 与 Standards Review 批次。
- 含子仓库参与的工作区为每一次仓库交付保留一次 per-repository delivery review，并为收尾保留一次独立的 finalization review，零任务根没有人为的 root-delivery review；不存在 per-task、per-phase 或 per-commit 触发器，也不存在超出变更类别的未定义 larger 或 high-risk 触发器。
- 规划澄清业务意图，在内存中用两种语言起草，运行一次完整 Spec Review，自动修复范围内错误并至多做一次受影响发现的定向复核，然后才呈现完整的最终确认；批准之前不存在计划目录、`spec.md`、摘要或 task 文件，而该评审之后的实质性用户变更会开启新的规划边界与 plan ID，而不是复用陈旧证据。
- 主代理聚合两个轴的发现，对已证实且在既定或冻结验收与既有写入范围内的缺陷自动委派一次聚合修复，不询问修复哪些发现；Test 先撰写必需的测试改动；每个边界至多允许一次聚合修复与一次定向复核批次，只派发受影响的轴，两轴都受影响时同时派发，并携带原始发现标签、修复 diff 与新鲜证据。
- 未达成的 AC、被引用的必需标准违规或缺失的必需证据属于阻塞项，且不可用或失败的必需证据保持阻塞；warning 是建议性的，须带有具理由的处置，且绝不掩盖阻塞项。可证明为无依据或重复的发现同样须带有具理由的处置，且不得被静默丢弃。业务或验收变更、范围扩张、REQ/AC 变更或已交付子仓库编辑会停在有界的决策、新计划或支持请求上，而不是进行未授权编辑。
- 执行 Status 与评审 Verdict 保持分离：`done` 表示执行完成，绝不替代 Verdict PASS；冻结或集成要求完整的已分配验收证据且没有未解决阻塞项，而未解决阻塞项或不可用的复核会以 `blocked` 或 `failed` 停止，不进入第二次修复或评审循环。
- 在非快进集成之前，主代理提供确切的已接受来源 HEAD、仓库、worktree、用途、基线与目标，以及评审与检查证据；只有 Git Operator 比较实际的干净来源 HEAD 与该已接受 HEAD，并在合并前拒绝漂移，而由此得到的交付合并 SHA 被独立记录，且不必等于来源 HEAD。
- 工作区 `reviewed_commit` 只在修复、检查、复核与收尾均被接受之后写入一次，保持用途限定，绝不复用于另一用途或已变更的 HEAD；CLI 检查点成功只证明一次记录状态转换，不证明评审 PASS 或 Git 相等。
- 该策略发布在 `templates/project/AGENTS.md`、`templates/skills/planning/SKILL.md`、`templates/skills/coding/SKILL.md`、`templates/skills/coding/references/workspace.md`、`templates/skills/plan-to-tasks/SKILL.md`、`templates/agents/spec-review.md`、`templates/agents/standards-review.md` 与 `templates/agents/git-operator.md`，并由 `tests/behavior/review-policy.test.ts` 以及 `tests/behavior/planning-content.test.ts` 中被替换的冲突断言守护。

## Alternatives considered

- **保留未定义的 larger 或 high-risk 评审触发器。** 放弃：不确定的触发器意味着同一变更可能被评审、也可能不被评审，而变更类别已提供确定的边界。
- **保留常规的"只修选定项与修复全部"选择。** 放弃：询问修复哪些发现会拖延一项验收与写入范围本已授权的范围内修复，且所请求的处置是自动的、无选择提示的。
- **允许第二次完整评审或无界修复循环。** 放弃：一次聚合修复与一次受影响轴复核使每个边界保持有界，而未解决阻塞项必须停止而不是循环。
- **把成功检查点或 `done` 状态当作验收。** 放弃：一次记录状态转换不证明任何语义裁决，因此验收证据与干净的来源 HEAD 须分别提供。
- **把交付合并 SHA 等同于已评审的来源 HEAD。** 放弃：非快进合并合理地产生不同的交付 SHA，因此二者作为独立证据记录。

## Consequences

- 已交付策略由 shipped-content 测试守护：`tests/behavior/review-policy.test.ts` 与 `tests/behavior/planning-content.test.ts` 中被替换的断言以 RED 运行，40 项检查中 13 项失败、27 项通过，随后在一次聚合修复后 40/40 通过。Step 1 产品提交为 `3a7083eb7f4f16501b8d189a605592e649a0247a`，其父提交为 `739f54414f77e887d022ebb7976d34bf22d941c9`。这些是静态 shipped-content 断言，不证明真实的模型行为。
- Step 1 回归还运行了 behavior/install 批次，为 23 个文件、281 项检查通过且退出码 0，以及有范围的 project-sync 批次，为 5 个文件、68 项检查通过且退出码 0；两者都是静态 shipped-content 与兼容性守护，而非真实行为。
- Step 2 夹具轨迹在 `<coding-worktree>/tests/.review-policy-smoke/` 下的可丢弃夹具中演练了该策略：一个 Spec-only 边界与一个 both-axes 边界各自运行一次并行的完整评审对、一次无选择提示的自动本地修复与一次定向复核；Spec-only 用例只复核 Spec，both-axes 用例在一次并行批次中复核 Spec 与 Standards。真实的主代理原生派发、Test 命令与 Git Operator 比较均已执行，而种子、需求文本与验收措辞是合成的用例数据，且未创建任何中心记录或运行时凭据。Git Operator 在文档提交之前移除了这些自有夹具。
- 同一轨迹覆盖了有界门禁与范围用例：一次未解决的 Test-gate 失败扣下了验收与集成且没有修复循环，一个提议的越界文件被归类为有界的范围决策而非被授予，没有任何文件被编辑，且 Git 证实其不存在。在 Git 用例中，Git Operator 比较了已接受来源 HEAD 与实际候选 HEAD，并在任何 checkout 或 merge 之前拒绝漂移，而已接受来源 HEAD `778abe50f857d054ed28af7d6b1cdfa75f2eb152` 产生了不同的非快进交付合并 `00e8c9596d824527b819e560381caf82cbfa88cf`，其交付 SHA 与来源 HEAD 不同。
- 该轨迹证明至少一个真实可用的宿主：OpenCode 原生主代理运行了这些有界的常规评审、修复与门禁用例。Claude Code 与 Codex 未被演练，没有真实的 HOME 角色文件被刷新，既有的三宿主原生覆盖缺口保持为明确的限制而非被声称通过；规划用户确认与子仓库参与的工作区会话均未在这些 smoke 中运行，仅由静态回归测试覆盖。
- 四个相关的活动笔记保留其独立的决策与理据：[变更分流](./2026-09-22-change-routing.md)负责分类，[规划与编码的会话边界](./2026-09-23-planning-coding-session-boundary.md)负责 Planning 到 Coding 的交接，[自动实施提交](./2026-10-14-automatic-implementation-commit.md)负责自动本地提交，[父级工作区编码编排](../feature/2026-10-09-workspace-coding-orchestration.md)负责父级工作区执行。本记录不取代其中任何一个：它记录的只是对先前存在于已发布技能与角色中的评审选择与不复核规则的替换，并保留全部四条交叉链接、其独有理由、归属与覆盖缺口，且不改写其历史。
