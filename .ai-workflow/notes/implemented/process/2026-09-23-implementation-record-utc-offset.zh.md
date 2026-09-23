# Agent Note: 计划实施记录的 UTC+08:00 时间戳

Status: implemented

[English](2026-09-23-implementation-record-utc-offset.md) | 中文

## Problem

[计划实施记录](./2026-09-22-plan-implementation-record.md)要求 `started_at` 与 `completed_at` 为 ISO 8601 值，但没有固定时区，因此某次运行可能写入 UTC `Z` 值，而阅读该记录的维护者使用 UTC+08:00。这样一来每次阅读都要做一次心算换算，而在不同配置机器上写出的记录可能带有掩盖真实先后顺序的偏移量。

## Decision

- `implementation.yaml` 的 `started_at` 与 `completed_at` 值使用 UTC+08:00 时区的 ISO 8601 格式，例如 `2026-09-23T15:04:05+08:00`。`Z` 后缀或任何其他偏移量都不可接受。
- 该要求由以下文本共同陈述：`templates/skills/coding/SKILL.md` 中的 `coding` 技能、`templates/project/AGENTS.md` 与 `.ai-workflow/AGENTS.md` 中的项目契约、`templates/project/MEMORY.md` 与 `MEMORY.md` 中的项目记忆以及 `README.md`；`tests/behavior/implementation-record.test.ts` 守护这些已发布文本。
- 既有记录不会被重写或迁移：该记录是本地运行时状态，本变更只作用于已安装宿主文本刷新之后写出的记录。

## Alternatives considered

- **继续使用 UTC（`Z`）时间戳。** 放弃：该记录唯一的读者使用 UTC+08:00，UTC 值会让每一次阅读这份唯一时间记录都多一次换算。
- **不固定时区，跟随写入机器的本地时区。** 放弃：处于不同本地时区的机器会写出偏移量不同、从而掩盖运行真实先后顺序的记录。
- **写入不带偏移量的 UTC+08:00 裸时间。** 放弃：不带偏移量的值不是完整的 ISO 8601 时刻，会重新引入本决策要消除的歧义。
- **增加可配置的时区设置或 CLI 校验。** 放弃：本项目只有一个时区，该记录是 `plan validate` 与 `plan pairing` 都忽略的本地状态，不需要配置面或校验面。

## Consequences

- 每份新的 `implementation.yaml` 都无需换算即可按维护者的本地时间阅读，在不同配置机器上写出的记录也保持可直接比较。
- [计划实施记录](./2026-09-22-plan-implementation-record.md)整体仍然有效；本记录只固定了它此前留空的时区，没有其他活动记录被取代。
- 已安装的技能、契约与记忆文本只有在下一次宿主安装或 profile 激活之后才携带该规则。
