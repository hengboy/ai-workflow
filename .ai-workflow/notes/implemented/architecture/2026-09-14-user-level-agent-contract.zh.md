# Agent Note: Move the agent contract into user-level global instruction files

Status: implemented

[English](2026-09-14-user-level-agent-contract.md) | 中文

## Problem

`ai-workflow init` 过去会写入项目级 `AGENTS.md` 与 `CLAUDE.md`，并在两者任一已存在时预检中止；`ai-workflow update` 负责维护这些受管模板以及专属的 `.ai-workflow/project-manifest.json`。这使同一份代理契约在每个项目重复写入：契约无法随用户一次性生效，任何已含手写 `AGENTS.md`/`CLAUDE.md` 的项目都会被 `init` 拒绝，且维护命令与项目文件所有权记录相互绑定。

## Decision

把代理契约改为用户级：`ai-workflow install` 在每个 host 的全局指令文件中写入或刷新一个由 `<!-- ai-workflow:begin -->` 与 `<!-- ai-workflow:end -->` 界定的标记块——opencode `~/.config/opencode/AGENTS.md`、claude `~/.claude/CLAUDE.md`、codex `~/.codex/AGENTS.md`。契约文本单源于 `templates/contract/AGENTS.md`，三个 host 复用同一份内容；每个 host 在 `~/.config/ai-workflow/install-manifest.json` 顶层 `contracts` 映射中记录 `path`、块级 `digest` 与 `created`。

`ai-workflow init` 只写 `MEMORY.md`、`.ai-workflow/**` 与 `.gitignore`，不再写入、不再预检项目级 `AGENTS.md`/`CLAUDE.md`。项目级 `AGENTS.md`/`CLAUDE.md` 契约模板、`ai-workflow update` 子命令与 `.ai-workflow/project-manifest.json` 一并移除；既有的项目级 `AGENTS.md`/`CLAUDE.md` 不被触碰。

该机制已被取代：2026-09-16 的[项目契约与 Agent Notes 替代记录](../process/2026-09-16-project-contract-and-agent-notes.md)保留了“契约随用户安装一次即生效”的取向，但全局文件中的完整契约文本被收窄为一条短加载入口，完整契约改为写入接入项目的 `.ai-workflow/AGENTS.md`（单源于 `templates/project/AGENTS.md`）。`install` 仍维护用户级标记块与 `contracts` 记录；被取代的是契约文本所在的层级，而不是标记块机制。

## Alternatives considered

- **保留项目级契约并让 `update` 继续维护。** 拒绝：契约文本在每个项目重复，已含手写 `AGENTS.md`/`CLAUDE.md` 的项目仍被预检拒绝，用户级一次性生效的收益无法实现。
- **继续写入 `.ai-workflow/project-manifest.json` 以保留所有权记录。** 拒绝：受管对象只剩用户级全局文件，项目级 manifest 已无消费者。
- **为每个 host 定制契约文本。** 拒绝：三 host 的规则一致，单源模板即可，避免分叉与漂移。

## Consequences

- 契约随用户安装一次即对所有项目生效，仅在项目根存在 `.ai-workflow/` 时适用；项目级手写 `AGENTS.md`/`CLAUDE.md` 不再与 `init` 冲突，也不被写入或修改。
- 块外内容逐字节保留；重跑 `install` 刷新未手改的块、跳过手改的块并报告 `skipped`、接管无记录的合法块，畸形或重复标记判为冲突且不改文件。`uninstall --host <host>` 只移除标记块。
- 块记录位于顶层 `contracts` 而非 `hosts` 条目，旧版卸载逻辑不会误删整份全局文件；旧版 `install` 丢弃 `contracts` 后，磁盘块转为无记录并由新版接管。
- `update` 子命令与 `.ai-workflow/project-manifest.json` 的移除是破坏性变更，当时版本号为 `0.1.0`。
- `README.md`、`templates/skills/setup-ai-workflow/SKILL.md` 与 `MEMORY.md` 在同一变更内对齐了新语义。
- 取代带来的代价：契约文本不再完整存在于全局文件，缺失 `.ai-workflow/AGENTS.md` 的项目必须以 `ai-workflow init <project-root> --upgrade` 作为修复入口，不再回退到旧的全局完整契约。
