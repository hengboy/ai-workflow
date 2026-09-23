# Agent Note: Derive the ADR list on read

Status: implemented

[English](2026-09-14-derive-adr-list-on-read.md) | 中文

## Problem

更早的机制存放一份生成的 `.ai-workflow/adr/INDEX.md`，并用 `ai-workflow adr index --verify` 保护它。生成文件消除了手工编辑造成的漂移，但存储副本仍是第二个产物：一旦跳过重新生成就会过期，而且要求工作流携带一个需要读取和刷新的索引文件。完全不落盘的投影不会漂移。

## Decision

- 不存放 ADR 索引文件。`.ai-workflow/adr/INDEX.md` 被移除且不再重新生成。
- `ai-workflow adr list --project <root>` 读取每个 `NNNN-*.md` 的记录头字段，忽略不匹配 `NNNN-*.md` 的条目（例如 `notes.md`），并输出确定性的升序表格，列为 `#`、`Status`、`Date`、`Supersedes`、`Superseded-by` 与 `Summary`。
- 取代关系与记录头字段遵循 ADR 契约：记录头字段是权威来源，`Superseded-by` 列由 `Status: superseded-by ADR-NNNN` 派生，`accepted` 正文保持不可修改。
- `MEMORY.md` 引用 `ai-workflow adr list` 命令，而不是某个文件或具体 ADR 编号。
- 读者先运行该命令做状态与主题分诊，再只打开与本次变更相关的 `accepted` 与 `proposed` ADR。运行命令需要 CLI；直接阅读 ADR 本身不需要。

该机制已被取代：`ai-workflow adr` 命令与 `.ai-workflow/adr/` 记录已由 2026-09-16 的[项目契约与 Agent Notes 替代记录](../process/2026-09-16-project-contract-and-agent-notes.md)整体移除，当前的查找与分诊入口改由 `.ai-workflow/notes/` 与 `ai-workflow notes list` 承担，本记录只保留当时的决定与理由。

## Alternatives considered

- **保留生成的 `INDEX.md` 与 `--verify`。** 否决：它只是限制了过期程度，仍然存放第二个产物，一旦漏掉重新生成就会漂移。
- **手工维护索引。** 否决：记录头字段的独立副本必然漂移。
- **不提供命令，由读者自行扫描记录头。** 否决：会失去唯一确定性的分诊入口，虽然它可以避免 CLI 依赖。

## Consequences

- 漂移在结构上不可能发生：没有会过期的存储索引。
- 每次分诊读取都要付出目录扫描与记录头解析的代价，而不是读取一个文件；ADR 目录足够小，这一代价可以接受。
- 索引分诊需要 `ai-workflow` CLI，而直接阅读 ADR 仍然是无依赖的纯 Markdown。
- `adr index` 命令与 `--verify` 被移除，`adr list` 成为唯一的 ADR CLI 界面。
- 这条路径现已不存在：没有 `adr` 命令，也没有 `.ai-workflow/adr/` 记录；记录与分诊改由 `ai-workflow notes list` 提供，见[项目契约与 Agent Notes 替代记录](../process/2026-09-16-project-contract-and-agent-notes.md)。
