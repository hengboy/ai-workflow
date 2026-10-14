# Agent Note: Fresh sub-agent sessions for completed roles

Status: implemented

[English](2026-10-14-fresh-subagent-sessions.md) | 中文

## Problem

已返回执行状态 `done` 的受委派角色会话，仍可成为下一次委派的目标。已交付的契约与 `coding` 提示词要求每个步骤把某角色的工作合并为一次派发，且仅在有新证据的审阅修复时才允许第二次派发，但从未结束一个已完成的子代理会话，也未要求后续同名角色的工作开启新的原生会话。没有任何规定禁止把已完成会话的标识传入续接参数，也没有界定新会话应接收的上下文范围。因此，已完成任务的对话上下文可能在后续实施、修复、验证或复验、文档和 Git 委派中持续累积并降低有效性，而新会话又缺少对当前必需上下文的明确要求。

## Decision

- 返回执行状态 `done` 的子代理会话即告结束。后续向同名角色委派的任何任务、修复、验证或复验、文档和 Git 工作都必须开启新的原生子代理会话；绝不复用或恢复已完成会话，包括将其标识传入续接参数或任何其他续接机制。
- 该规则是覆盖上述后续委派的同一边界；它不新增授权，也绝不把 `done` 结果当作审阅 PASS。复用角色名称并开启新会话仍然有效。
- 新会话必须显式读取或完整接收当前必需的项目上下文、`MEMORY.md`、两份导航文件、项目契约、当前任务目标、准确的读写范围、允许的命令，以及相关已接受结果或可执行的审阅发现，而不是前一完整对话。
- 理由是已完成任务上下文可能累积并降低有效性；新会话可限制这种累积，且不宣称已测得性能提升。
- 该规则写入 `templates/project/AGENTS.md`（`## Orchestration`）、其受跟踪的 `.ai-workflow/AGENTS.md` 副本，以及 `coding` 技能的 `## Delegation and Scheduling`；`README.md` 和 `MEMORY.md` 记录同一标准，`navigation.json` 记录 `fresh-subagent-sessions` 功能及其生成的 Markdown。

## Alternatives considered

- **续用已完成会话承担后续同名角色工作。** 已否决：已完成会话会持续累积可能降低有效性的已完成任务上下文，而所要求的行为是对每次后续委派开启新会话。
- **开启新会话但复制全部旧对话。** 已否决：复制完整旧对话的新会话保留了本变更要限制的累积；只交接当前上下文以及相关已接受结果或可执行的审阅发现。

## Consequences

- 后续同名角色的实施、修复、验证或复验、文档和 Git 工作现在都以范围明确的当前任务包开启新的原生会话，同时执行状态与审阅结论保持分离，既有的授权与审阅边界不变。
- `templates/project/AGENTS.md` 与受跟踪的 `.ai-workflow/AGENTS.md` 副本在本变更中保持相等，且安装后的 Coding 与 `templates/skills/coding/SKILL.md` 字节一致，因为安装按原样写入模板；其他角色和技能通过共享项目契约取得该规则，因此没有角色模板或其他技能被修改。
- `tests/behavior/coding-v2-content.test.ts` 中的聚焦交付内容用例在修改提示词之前观察到 RED：`pnpm exec vitest run tests/behavior/coding-v2-content.test.ts` 在该用例的 `contract ## Orchestration ends the session once Status done is returned` 断言处失败，而既有 17 个用例通过，原因是规则缺失。
- 范围明确的交付内容、安装传播和文档检查是静态验收边界；即使通过，也只证明提示词已交付，仍不证明宿主运行时强制执行、审阅接受或模型能力已实测提升。
- [Review boundaries and repair](./2026-10-14-review-boundaries-and-repair.md) 保留其独立的审阅与修复决策，[Automatic implementation commit](./2026-10-14-automatic-implementation-commit.md) 保留其自动本地提交决策；本记录不取代其中任何一个，并保留既有的主会话恢复以及未完成或受阻处理。
- 当宿主在后续同名角色委派后报告原生会话标识时，该标识是补充性宿主证据，不产生额外的工作流产物、夹具或对话记录。
