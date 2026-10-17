# Agent Note: 当验收标准保持不相交时，切片清单可以共享定稿需求

Status: implemented

[English](2026-10-12-slice-finalization-shared-requirements.md) | 中文

## Problem

一个组合工作区计划可以声明可选的、由根拥有的 `workspace_finalization` 覆盖，而 `ai-workflow plan validate` 要求分发出去的切片清单不得携带该定稿覆盖。`src/workflow/workspace.ts` 中 `validateWorkspaceManifest` 的切片分支把切片声明的 `requirements` 与 `acceptanceCriteria` 同时对照 `workspace_finalization.requirements` 和 `workspace_finalization.acceptanceCriteria` 进行比较，因此任何业务需求同时被定稿拥有的切片都会以 `Slice manifest must not carry workspace_finalization criteria` 失败。当一个冻结计划中的子任务合法地携带一个根定稿也拥有的业务需求时——例如某个 ISP 计划的子任务与根定稿共享若干业务需求，而每条验收标准都保持不相交——即使每条验收标准都保持不相交，该计划仍被拒绝。

## Decision

- `src/workflow/workspace.ts` 中 `validateWorkspaceManifest` 的切片分支只用切片声明的 ID 对照 `workspace_finalization.acceptanceCriteria` 比较，因此切片需求也可以属于 `workspace_finalization.requirements`。
- 不相交性只约束验收标准：切片不得携带任何 `workspace_finalization` 验收标准，因为定稿标准保持由根拥有，且绝不会被分配给任务。
- 其余校验保持不变：已知需求与已知验收标准检查、切片归属检查、需求与验收标准的精确任务并集覆盖检查，以及工作区根的定稿与仓库顺序强制，都保持原有行为。
- 该修正确由两个回归守护：`tests/integration/plan-workspace-cli.test.ts`（`accepts a slice manifest that shares a business requirement with workspace_finalization while its criteria stay disjoint`）以及 `tests/integration/workspace-distribute-cli.test.ts`（`distributes slices that each validate when a child task shares a finalization requirement with disjoint criteria`）。

## Alternatives considered

- **继续把切片需求对照 `workspace_finalization.requirements` 比较。** 放弃：需求是属于子任务与根定稿都可能合法承担的业务意图，只有验收标准需要不相交的归属，因此共享需求是合法的，拒绝它会阻断一个合法的跨仓库计划。
- **完全移除定稿携带检查。** 放弃：切片绝不能声明一条定稿验收标准，那会造成根拥有验证的双重分配，因此保留对验收标准的不相交检查。
- **通过复制需求 ID 在需求与验收标准两侧同时强制不相交。** 放弃：这会强加人为的 ID 复制并破坏精确的计划覆盖，而不会在验收标准边界之外增加任何保障。

## Consequences

- 切片清单现在接受与 `workspace_finalization` 共享的需求，同时仍然拒绝共享的定稿验收标准，且该修正是 `src/workflow/workspace.ts` 中的一处谓词。
- 修正后的规则与 `templates/skills/planning/references/plan.md` 一致：该文件已说明定稿标准与每个任务的验收标准不相交，且子集保持恰好等于其自身任务；`MEMORY.md` 记录同一标准。
- 验证：在谓词被回退时，两个回归失败（38 个中 2 个失败、36 个通过），错误为 `Slice manifest must not carry workspace_finalization criteria`；应用修正后，`pnpm exec vitest run tests/integration/plan-workspace-cli.test.ts tests/integration/workspace-distribute-cli.test.ts` 通过（38 个通过、2 个文件），且 `pnpm typecheck` 通过。
- 部署：Git Operator 把六个已跟踪文件与三个新文件按字节精确地落入源仓库 `/Users/yuqiyu/AiHistorys/ai-workflow`，并保持它们未暂存、源 `main` `HEAD` `ed348bab9605587f1be87cfb670f773ade6c9a32` 不变；`pnpm install` 报告依赖与 lockfile 均已是最新，`pnpm build`（`tsc -p tsconfig.build.json`）成功，PATH CLI `ai-workflow --version` 报 `0.1.0` 且与 `package.json` 一致。包装脚本 `/Users/yuqiyu/.local/bin/ai-workflow` 执行 `/Users/yuqiyu/AiHistorys/ai-workflow/dist/cli.js`，因此本地 CLI 现在携带修正后的谓词。
- 真实 ISP 验证：通过 PATH CLI，三个 `ai-workflow plan validate --plan <absolute-plan-directory>` 命令对 ISP 工作区 `.ai-workflow/plans/` 目录下的父计划及其 center 与 sync 子计划都返回 `valid: true`；三者保持相同的原始 `spec` 摘要 `437592473222eb5c920ef37f54e59765a13ca0c1a7003a4ecb1c8d2b40e62352` 与 `plan` 摘要 `25ba844812e2a8c10e7ffdae44ddd3f689a539238a589f59ba33388f8d5dc25c`（父计划 11 个阶段，center 6 个，sync 4 个）。`ai-workflow workspace distribute --plan <parent>` 返回 `valid: true` 且两个切片均未变化，`ai-workflow workspace status --plan <parent>` 返回 `valid: true`，两个切片均存在、处于首个执行阶段且有一个待处理任务，所有实现记录缺失，因此没有开始实现。本记录不声称任何 ISP 实现或生产门禁已完成，且源修正按授权保持未提交。
- 本记录修正了 [父工作区编码编排记录](../feature/2026-10-09-workspace-coding-orchestration.md)、[子模块工作区交付记录](../architecture/2026-09-30-submodule-workspace.md) 与 [工作区执行一致性记录](./2026-10-08-workspace-execution-consistency.md) 所引用的定稿共享细节；每份记录都保留其决定、理由与证据边界，且没有任何活动记录被完全取代。
