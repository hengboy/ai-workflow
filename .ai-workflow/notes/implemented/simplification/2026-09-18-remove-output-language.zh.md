# Agent Note: Remove the output_language configuration

Status: implemented

[English](2026-09-18-remove-output-language.md) | 中文

## Problem

`~/.config/ai-workflow/config.yaml` 中可选的 `output_language` 键曾用于本地化生成的散文，但依赖它的产物族已经变成完整的双语三件套：Agent Notes 与规划产物始终同时以英文和中文写出，只有结构性元素保持英文。因此该偏好已不再选中任何仍以单一语言生成的产物，却保留了一处可能与「始终双语」契约漂移的配置面，并在用户更改它时强制重新安装。

## Decision

- `output_language` 配置特性被整体移除。`~/.config/ai-workflow/config.yaml` 现在只携带可选顶层字段 `active_profile`，以及被允许的 `version` 键。该键已从 `schemas/settings.schema.json`、`src/settings/index.ts`（`OutputLanguage` 类型与 `loadOutputLanguage` 已删除）以及生成的设置类型中删除。
- schema 保留 `additionalProperties: false`，因此残留的 `output_language` 键现在是未知键，会在 install 写入任何受管文件前让配置加载失败；用户必须删除它。
- install 不再注入任何散文语言指令：`src/install/render.ts` 移除了输出语言段落，因此安装的技能与角色代理逐字节写自其模板，只保留按宿主的前言转换。这也移除了「更改偏好需要重新安装」的安装期耦合。
- Agent Notes 与规划产物始终是完整的双语三件套，且没有任何配置选择它们的语言。
- planning 技能在 `templates/skills/planning/SKILL.md` 中的编号工作流现在起草并写出全部六个冻结文件（`spec.md`/`spec.zh.md`/`spec.i18n.yaml` 与 `plan.md`/`plan.zh.md`/`plan.i18n.yaml`），并把 `ai-workflow plan validate --plan <目录>` 当作硬性完成闸门，因此 `spec.md` 或 `plan.md` 绝不会在没有其 `.zh.md` 与 `.i18n.yaml` 的情况下被冻结。
- `standards-review` 角色与 README/MEMORY 已更新以删除偏好相关措辞。
- 本记录部分取代[安装期本地化 ADR 散文](../process/2026-09-14-localize-adr-prose-at-install-time.md)、[双语 note 三件套](../process/2026-09-17-bilingual-note-triplets.md)与[双语规划产物](../process/2026-09-17-bilingual-planning-artifacts.md)中关于 `output_language` 的主张；那些记录保留其决定与理由，其当前语言事实指向本记录。

## Alternatives considered

- **保留该键但使其失效。** 放弃：这会留下一处死亡配置面，用户继续设置、文档继续解释、校验继续接受，尽管已没有任何代码读取它。
- **静默忽略未知键。** 放弃：这会削弱配置校验并掩盖拼写错误，包括拼错的 `active_profile`，因为会加载 schema 从未批准过的设置。
- **保留固定的内置英文指令。** 放弃：这仍暗示存在一个可更改的偏好，并重新引入必须通过重新安装来注入和刷新的安装期耦合。

## Consequences

- 残留的 `output_language` 键现在会让配置加载失败，直到用户删除它；没有兼容垫片，也没有静默回退。
- 安装的技能与角色代理只是模板字节加上按宿主的前言转换，因此模板成为唯一来源，install 不再与散文偏好耦合。
- 双语三件套仍由机械方式强制：`ai-workflow plan validate` 与 `ai-workflow notes validate` 仍是闸门，而不是某个配置值。
- 散文语言不再可配置；代理遵循宿主与会话上下文，「始终双语」的产物规则是唯一的语言保证。
