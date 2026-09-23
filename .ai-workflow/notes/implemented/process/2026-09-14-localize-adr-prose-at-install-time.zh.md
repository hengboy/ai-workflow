# Agent Note: Localize ADR prose at install time

Status: implemented

[English](2026-09-14-localize-adr-prose-at-install-time.md) | 中文

## Problem

ADR 正文由 Documentation Maintainer 撰写，而 `output_language` 此前只覆盖 planning 类技能。ADR 契约要求字段名、`Status`、`Supersedes`、`NNNN-kebab-title.md` 与 `superseded-by ADR-NNNN` 保持英文。

## Decision

在安装时把配置好的语言指令注入 Documentation Maintainer。ADR 的自然语言内容按该偏好本地化，结构性字段与协议取值保持英文。

该机制已被取代。2026-09-16 的[项目契约与 Agent Notes 替代记录](./2026-09-16-project-contract-and-agent-notes.md)删除了 ADR 专有字段与撰写规则，2026-09-18 的[移除 output_language 记录](../simplification/2026-09-18-remove-output-language.md)则整体移除了安装期语言注入。notes 与规划产物现在始终是完整的双语三件套，且没有任何配置选择它们的语言。

## Alternatives considered

原记录没有列出备选方案：迁移保留这一事实，不补写决策时未经记录的方案。

## Consequences

- ADR 撰写遵循用户偏好；改变该偏好需要重新安装。
- ADR 结构与 `adr list` 输出保持英文。
- 这些 ADR 专有结构现已退役，安装期注入随后由 2026-09-18 的[移除 output_language 记录](../simplification/2026-09-18-remove-output-language.md)移除。notes 仍是双语三件套，正文被翻译，而 `# Agent Note:` 前缀、段落标题、字段名、`Status` 取值、路径与日期保持英文，见[项目契约与 Agent Notes 替代记录](./2026-09-16-project-contract-and-agent-notes.md)。
