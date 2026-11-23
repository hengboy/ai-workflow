# Agent Note: Antigravity 作为第四个原生宿主

Status: implemented

[English](2026-11-22-antigravity-host-support.md) | 中文

## Problem

`Host` 以及每个接受宿主的 CLI 入口只认识 `codex`、`claude` 和 `opencode`。运行 Antigravity CLI（`agy`）的用户完全无法安装本工作流：不会渲染任何角色 agent，不会注册同步入口，`sync-hook`、`doctor` 与 `host smoke` 都拒绝该宿主名，profile 也无法表达 Antigravity 的模型层级。Antigravity 从个人目录发现自身配置，因此该适配器必须按其原生格式设计，而不是沿用三个既有宿主的假设。

## Decision

Antigravity 作为第四个受支持宿主加入 `src/workflow/types.ts` 中的 `Host`，并由 `src/install/render.ts`、`src/install/hooks.ts`、`src/install/index.ts`、`src/install/verify.ts`、`src/sync/gate.ts`、`src/cli.ts`、`src/ops/doctor.ts` 与 `src/host/smoke.ts` 中的原生宿主集成交付，而不是通过宿主专属插件或第二套 skill 目录树。

- 角色 agent 是 Antigravity 原生 Markdown `<role>.md` 文件，位于 `~/.gemini/config/agents/`，带有 `name`、`description`、`tools`、`subagent: true`、`mainAgent: false` 以及可选的 `model` 层级。模板工具词汇把 `read` 映射为 `read_file`，`edit` 映射为 `edit_file` 与 `write_file`，`shell` 映射为 `run_command` 与 `manage_task`，`web` 映射为 `search_web`，`search` 映射为 `run_command` 与 `manage_task`，按顺序去重，且任何渲染出的角色都不得获得嵌套派发工具。
- skill 仍然单源于 `~/.agents/skills/`。Antigravity 通过 `~/.gemini/config/skills.json` 中恰好一个受管条目访问它们，该条目携带绝对路径 `<home>/.agents/skills` 与已排序的 `include_only` 列表，因此 `~/.gemini/` 之下不复制、不软链任何内容，共享目录中的无关 skill 对 Antigravity 保持不可见。
- `~/.gemini/AGENTS.md` 携带来自 `templates/contract/AGENTS.md` 的单源加载块，而 `~/.gemini/GEMINI.md` 从不被创建、读取或修改。
- `~/.gemini/config/hooks.json` 持有一个受管的顶层键 `"ai-workflow-sync"`，包含 `SessionStart`、`PreInvocation` 与 `PreToolUse`（matcher 为 `*`）。安装器从不写入 `enabled`，保留无关键，把用户自己的 `enabled: false` 报告为 `disabled` 且不重写，把无归属或被手工修改的键保留在 `skipped` 中，卸载只移除该键，且仅当本次安装创建了该文件并只剩一个空对象时才删除文件。
- `sync-hook --host antigravity` 消费驼峰命名的 `hookEventName`、`conversationId`、`cwd`、可选 `invocationNum` 与可选 `toolCall`。`allow` 在 `SessionStart` 注入 `injectSteps.systemMessage`，在 `PreInvocation` 仅在 `invocationNum` 省略或为 `0` 时注入，更大时返回 `{}`。`deny` 在 `SessionStart` 返回上下文加后续说明，在 `PreInvocation` 返回带 `terminationBehavior: "terminate"` 的 `injectSteps.errorMessage`，在 `PreToolUse` 返回 `{"decision":"deny","reason":...}`。被放行或跳过的 `PreToolUse` 写出零字节。
- 门禁豁免精确的契约 `read_file`（`Path`）与同步执行者的 `run_command`（`CommandLine`），与其他宿主已有的豁免一致。
- `schemas/profile.schema.json` 只接受 `antigravity.model` 为封闭层级枚举 `inherit`、`flash_lite`、`flash` 与 `pro`；`inherit` 在渲染出的 agent 中省略该键。`reasoning_effort` 被 schema 接受，从不渲染，并由 `activateProfile` 报告为不阻塞的激活警告。
- `agy` 是 Antigravity 在 `doctor` 就绪检查中的可执行文件，且始终报告 `warn`，因为只读检查既验证不了认证也验证不了信任；它同样是 `host smoke` 中的可执行文件，运行 `agy --version` 与 `agy -p <prompt> --mode plan`。

## Alternatives considered

- 把工作流打包为 `~/.gemini/config/plugins/` 下的 Antigravity 插件。否决，因为 Antigravity 把插件 skill 加命名空间为 `<plugin>:<skill>`，会破坏既有提示词使用的每一个无前缀 skill 引用，而且插件会重复 skill 而无法让 `~/.agents/skills/` 保持为唯一物理来源。
- 把 skill 复制或软链到 `~/.gemini/config/skills/`、`~/.gemini/skills/` 或 `~/.gemini/antigravity-cli/skills/`。否决，因为副本会跨宿主漂移，`~/.gemini/skills/` 仅供 CLI，软链遍历未文档化，而带 `include_only` 的 `skills.json` 有文档、被 CLI 与 App 共用，并保持单一来源。
- 把 Antigravity hook 注册为裸的顶层事件键。否决，因为裸键无法在不与用户条目冲突的前提下被归属或刷新；单一命名键提供了安装刷新、无归属保留与精确卸载。
- 在受管 hook 中写入 `enabled: true`。否决，因为该值无法被验证，会误报激活状态并可能覆盖用户刻意的禁用。
- 对被放行的 `PreToolUse` 返回 `{}` 或 `{"decision":"allow"}`。否决，因为 `agy` 把 `{}` 视为拒绝，而 `{"decision":"allow"}` 会自动批准，从而绕过用户权限提示；空 stdout 能在不覆盖权限的前提下通过。
- 在 profile 中接受具体 Antigravity 模型 ID。否决，因为不受支持的 ID 在加载 agent 时静默失败，而封闭层级枚举在任何写入之前就拒绝它。

## Consequences

- 安装、卸载、验证、`doctor` 与 `host smoke` 都接受 `antigravity`，且 `--host all` 覆盖全部四个宿主；因为 `skills_manifests` 与 `named_hook` 同步记录是附加且可选的，manifest 保持向后兼容。
- Antigravity 的加载在真实会话运行之前被报告为已安装但未验证；被禁用、无归属或被手工修改的 hook 或 manifest 条目会被点名，而不是被静默批准。
- 本宿主复用的三个用户级加载、同步与共享 skill 机制分别描述于[用户级 agent 契约记录](../architecture/2026-09-14-user-level-agent-contract.md)、[项目模板同步记录](2026-10-08-project-template-sync.md)、[单次启动节奏记录](2026-10-09-sync-once-at-skill-start.md)与[评审证据与共享 skill 记录](../process/2026-11-05-review-evidence-and-shared-skills.md)；每条记录都保持活跃，因为它们各自的理由、替代方案与覆盖限制仍然原样适用。
- `tests/behavior/antigravity-agent-contract.test.ts` 守护渲染、工具映射与安装边界，而 `tests/install/sync-hooks.test.ts`、`tests/integration/project-sync-hooks.test.ts` 与 `tests/integration/global-agent-guidance.test.ts` 覆盖 hook 归属、原生协议与契约块。四宿主的原生父会话链路仍然是显式上报的缺口，而不是被声明的通过结论。
