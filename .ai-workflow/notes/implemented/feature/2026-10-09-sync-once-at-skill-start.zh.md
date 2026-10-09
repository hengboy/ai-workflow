# Agent Note: Synchronize once at skill start

Status: implemented

[English](2026-10-09-sync-once-at-skill-start.md) | 中文

## Problem

此前的自动同步会在宿主边界——会话开始、用户轮次、恢复与实际根变更——反复运行，且每个没有可复用单元的原生事件都会调用同步核心，因此上游 403 速率限制会在一次技能会话内产生重复的来源请求。

## Decision

- `PhaseEntry`（`ai-workflow sync-hook --host <host> --phase --project <actual-root>`）是唯一的自动触发：每次 planning、coding 或 plan-to-tasks 技能启动都为该操作的实际采用根运行恰好一次全新同步，并以该根为键把完整结果原子地存入项目之外的现有宿主运行时缓存。不创建项目本地的元数据、清单、版本戳或迁移。
- 原生 `SessionStart`、`UserPromptSubmit` 与 `PreToolUse` 事件绝不调用同步核心：它们原样返回已存结果（decision、project、context、report、authority），零来源请求。缺失、损坏或不可读的条目会产生 `allow`，并带有可见的无检查上下文、不作新鲜度声明且不写入。
- 会话、轮次、恢复与根变更事件不再使已存条目失效；下一次技能启动会原子地替换它。解析到同一实际根的会话与子代理共享该条目，而带有自身 `.ai-workflow/` 的编码 worktree 是独立的实际根，绝不重放项目根的判定。
- 未采用目录返回 `skip`，不发来源请求也不写运行时；精确的同步动作与契约读取豁免保留其 `allow` 结果且不清除已存的阻断；已存 authority 载荷继续强制契约重读；`conflict` 或 `failed` 的已存判定继续拒绝普通工具，直到下一次技能启动替换它们。
- `src/sync/gate.ts` 拥有新的 `runProjectGate` 行为，其 `ProjectGateInput` 不再声明过时的 `eventSource` 与 `parentSessionId` 输入，这是在 `src/cli.ts` 的 `sync-hook` 停止传递它们之后。三个技能在技能启动时调用一次阶段入口，手动 `sync-ai-workflow` 技能只记录该节奏而不获得触发器，项目契约、其模板与镜像、README 与两个 MEMORY 文件都描述单次启动节奏与仅缓存的原生事件。
- 手动 `ai-workflow sync [project]` 仍是全新且独立于缓存的检查，绝不替换已存门禁判定，宿主安装、卸载与每种宿主输出形态保持不变。
- 已交付的定向验证：`tests/unit/project-sync-gate.test.ts` 15 通过；`tests/integration/project-sync-hooks.test.ts` 与 `tests/integration/project-sync-cli.test.ts` 21 通过；`tests/behavior/project-sync-content.test.ts` 与 `tests/integration/global-agent-guidance.test.ts` 6 通过。

## Alternatives considered

- 基于时间的节流或可配置间隔。放弃原因是未批准任何新配置面，且问题在于节奏而非检索。
- 移除或削弱已安装的宿主钩子或插件。放弃原因是安装的增量性与输出形态保持不变。
- 增加会话开始、用户轮次或恢复触发器。放弃原因是它们会在速率限制下重建重复来源请求的失败。
- 在不同实际根之间共享同一缓存。放弃原因是 worktree 绝不能重放项目根的判定。
- 持久化项目本地的同步记录或版本戳。放弃原因是缓存仍是项目之外的临时宿主运行时状态，无需迁移。
- 在警告后自动重试来源。放弃原因是每次检查一次尝试、重复回放上下文是预期行为，不存在重试循环。

## Consequences

- 每个宿主、每个实际根、每次技能启动至多发生一次来源尝试。
- 已存警告会回放其上下文而不再发起第二次来源请求。
- 已存拒绝会持续到下一次技能启动替换它。
- 用户在已存 authority 之后编辑契约时，会保留已存要求直到下一次技能启动。
- 手动同步修补文件，但不替换已存判定。
- 上一格式遗留的会话文件不被使用。
- 完成全量门禁需要一次用户授权的基线修复：ESLint 配置现在忽略 `tests/install/`（与其他测试目录一致）以及随附的 `templates/hooks/opencode.js` 插件模板；`src/sync/index.ts` 与 `src/sync/merge.ts` 用守卫或兜底替换了非空断言；冲突比较器把未定义的 `path` 视为相等，以匹配此前语义；`templates/skills/plan-to-tasks/SKILL.md` 改写了其契约 "re-read" 句子，使 execution-order 段落成为随附测试所针对的那一段。相同的 lint 错误与测试失败在未改动的 `45cef2a` 检出上完全复现，且该修复由用户另行授权。
- 已知的既有局限，本计划未修复：`pnpm check` 在构建阶段之前运行测试阶段，而集成与插件钩子测试会启动已构建的 `dist/cli.js`，因此没有先前构建的干净检出可能使这些测试失败或运行过期构建；实现 worktree 依赖共享的预构建 `dist/`。这是需要单独处理的已知缺口，并非交付声明。
- 本记录部分取代 [项目模板同步](2026-10-08-project-template-sync.md) 的按边界节奏事实——其门禁生命周期 Decision 条目与技能的按步骤及按阶段条目——而该记录的检索、合并与报告契约仍然有效。
