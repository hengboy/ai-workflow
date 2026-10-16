# Agent Note: Note creation requires lasting decision rationale and defines retention

Status: implemented

[English](2026-10-16-note-rationale-and-retention.md) | 中文

## Problem

notes README 原先要求每个非机械变更都写 note，五个工作流消费方也重复了这条普遍义务。该规则会为那些原因已能从代码、测试与现有文档中还原的行为与架构变更重复记录，而 README 并未定义在役 implemented 记录的退役、归档或删除标准。作者只能凭习惯判断一篇小型机械记录能否丢弃、一篇保留的历史记录能否移除，语料库因此可能无指引价值地膨胀，或丢失仍然重要的决定。

## Decision

- note 的创建由代码、测试与现有文档无法充分解释的持久决定理由（lasting decision rationale）治理。仅行为变更、文件数量与新增测试本身并不充分，而缺少此类持久理由的本地、机械、UI、文案与格式化变更可获豁免。
- 复用拥有同一决定（owns the same decision）的现有 note，并在同一变更内保持其已交付事实为最新；已记录决定或其持久理由发生变化时，写一篇新的链接 note。
- 保留遵循未来指引价值：当其替代方案、归属、重要保证、数据语义或重新引入条件仍能指引未来工作时保留该 implemented 记录；对已完成、未来指引极少但具有历史决策价值的 implemented 决定进行归档；仅删除只描述小型 UI 调整或纯机械变更、没有持久决策价值的在役 implemented 三元组，绝不删除实现虽小但实质性的缺陷修复、性能变更、新能力或行为决定；仅当一条被拒绝记录能防止一个可信且有意义的错误时才保留它。
- 经授权的删除会移除完整三元组并修复入站链接，既有的替代关系保留与冻结归档禁令继续适用，本记录不授予任何清理权限。
- 五个消费方，即 planning、plan-to-tasks 与 coding 技能、documentation-maintainer 角色与 standards-review 角色，及其完成检查都遵循 README 标准，而不是各自要求每个非机械变更都写 note。
- 该政策通过既有的五文件模板快照及其同步交付，不涉及运行时、schema、CLI 或持久格式变更。

## Alternatives considered

- 保留普遍的非机械触发条件。放弃原因是它会为代码、测试与现有文档已解释的变更重复记录，增加审阅与维护成本却没有新指引。
- 复制参考项目的整套 note 保留政策。放弃原因是其剩余条款回应的是本项目并不存在的问题，会引入当前并不需要的规则、产物与校验面。

## Consequences

- README 仍是唯一治理来源，现在同时承载创建标准与保留结果；五个消费方指向它，而不再复述一条无条件触发条件。
- 2026-09-16 [项目契约与 Agent Notes 记录](./2026-09-16-project-contract-and-agent-notes.md)被部分细化：其项目契约与 notes 机制决定仍然成立，而创建义务与保留边界现在位于本记录所描述的 README 中。
- 既有决定仍需事实维护：重命名的路径、符号或默认值就地更正，只有已记录决定或其持久理由发生变化才创建新的 note。
- 交付仅限结构层面：随附内容检查与 `ai-workflow notes validate` 能证明格式、结构、配对与链接，但不能证明所记录理由真实或充分，这由语义审阅单独确立。
