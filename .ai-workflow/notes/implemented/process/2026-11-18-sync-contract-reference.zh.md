# Agent Note: Compact contract reference for the synchronization gate

Status: implemented

[English](2026-11-18-sync-contract-reference.md) | 中文

## Problem

存储的阶段入口结果曾把完整项目契约文本放在 `authority` 字段中，以便原生会话、提示与工具事件可以回放它。这使每个存储单元和每次回放的提示都与契约本身一样大，并与每个角色已被要求显式阅读的文档重复。保留字段名而改变取值形态同样不安全：较旧的已安装插件会把 `authority` 当作字符串比较，对象取值会永久拒绝普通工具。

## Decision

- `src/sync/gate.ts` 暴露紧凑的 `ProjectGateAuthorityRef`，包含绝对 `path`、`sha256:` `digest` 与字节数。阶段结果与存储单元携带 `decision`、嵌套的 `report`、简短的 `context` 与可选的 `authority_ref`；契约正文绝不被存储或回放。结果上下文以 `Project contract: <path>` 命名该路径，并附带在普通工作继续前读取该路径的指示。
- 存储单元为版本 2。版本 1 单元，或仍携带遗留 `authority` 字段的单元，不构成当前检查：读取方会以可见的无检查上下文放行，发起零次来源请求，不作任何写入，而下一次阶段入口会写入版本 2 单元。
- 仅当该次运行创建或更新了受管理权威文件时才存在引用；未更新阶段存储不含引用的结果。
- OpenCode v1（`templates/hooks/opencode.js`）与 v2（`templates/hooks/opencode-v2.js`）插件对给定的判定加上下文提示在每个会话中至多注入一次，仅在会话生命周期事件上清除提示状态，并以对 SHA-256 与引用匹配的确切契约的完成读取来门禁普通工具。注入提示不是读取，后续用户轮次不会使已完成的读取失效，子会话独立读取，带外编辑契约绝不会满足已存引用。
- 原始门禁 JSON 形态与 Claude Code、Codex 的宿主原生输出形态保持不变，手动 `ai-workflow sync` 命令与 `SyncReport` 语义同样保持不变。
- 已发布指引声明路径加摘要的提示不是完整契约注入，且每个角色都显式读取项目契约；契约模板及其镜像、OpenCode 插件模板与 `MEMORY.md` 承载该声明。

## Alternatives considered

- 把完整契约保留为额外的一次性阶段入口字段。放弃原因是它存储了每个角色都会显式阅读的文档的第二份完整副本，并持续回放它。
- 在读取时清洗版本 1 单元。放弃原因是为下一次阶段入口本来就会替换的过期全文契约文本增加兼容层。
- 保留 `authority` 字段名并改用对象取值。放弃原因是旧的已安装插件会把该字段当作字符串比较，并会永久拒绝普通工具。

## Consequences

- 原生回放保持简短，存储单元不包含契约字节。
- OpenCode 插件会阻断普通工具直到契约被读取，且契约被编辑后已存摘要失效，直到下一次阶段入口存储新的引用。
- 版本 1 单元会保持失效，直到下一次阶段入口替换它。
- 回滚到先前的 CLI 会把版本 2 单元视为无检查，直到下一次阶段入口重写它。
- 本记录部分取代[每次技能启动同步一次](../feature/2026-10-09-sync-once-at-skill-start.md)：其节奏、豁免、仅缓存的原生事件与已存拒绝行为仍然有效，而其全文 `authority` 载荷被紧凑的摘要引用取代。
- 本记录不取代[项目模板同步](../feature/2026-10-08-project-template-sync.md)、[生成的本地项目指令](../simplification/2026-10-10-generated-local-instructions.md)或[工作流语义、持久状态推进与角色范围上下文](./2026-11-02-workflow-semantics-context.md)；它们的检索、报告、五文件所有权与角色范围上下文决策仍然有效。
