# Agent Note: Slice manifests may share a finalization requirement when acceptance criteria stay disjoint

Status: implemented

English | [中文](2026-10-12-slice-finalization-shared-requirements.zh.md)

## Problem

A combined workspace plan may declare optional root-owned `workspace_finalization` coverage, and `ai-workflow plan validate` requires a distributed slice manifest not to carry that finalization coverage. The slice branch of `validateWorkspaceManifest` in `src/workflow/workspace.ts` compared a slice's declared `requirements` and `acceptanceCriteria` against both `workspace_finalization.requirements` and `workspace_finalization.acceptanceCriteria`, so any slice whose business requirement was also owned by finalization failed with `Slice manifest must not carry workspace_finalization criteria`. A frozen plan where a child task legitimately carries a business requirement that root finalization also owns — for example the ISP plan `20261012-data-platform-production-remediation`, whose `REQ-002`, `REQ-036` and `REQ-037` are shared while `AC-002`, `AC-005`, `AC-055` and `AC-059` stay disjoint — was rejected even though every acceptance criterion stayed disjoint.

## Decision

- The slice branch of `validateWorkspaceManifest` in `src/workflow/workspace.ts` compares a slice's declared IDs only against `workspace_finalization.acceptanceCriteria`, so a slice requirement may also belong to `workspace_finalization.requirements`.
- Disjointness governs acceptance criteria only: a slice must not carry a `workspace_finalization` acceptance criterion, because finalization criteria remain root-owned and are never assigned to a task.
- The remaining validation is unchanged: known-requirement and known-acceptance-criterion checks, the slice owner check, the exact task-union coverage check on requirements and acceptance criteria, and the workspace root's finalization and repository-order enforcement keep their behavior.
- The correction is guarded by two regressions: `tests/integration/plan-workspace-cli.test.ts` (`accepts a slice manifest that shares a business requirement with workspace_finalization while its criteria stay disjoint`) and `tests/integration/workspace-distribute-cli.test.ts` (`distributes slices that each validate when a child task shares a finalization requirement with disjoint criteria`).

## Alternatives considered

- **Keep comparing slice requirements against `workspace_finalization.requirements`.** Declined: a requirement is business intent that may legitimately span a child task and root finalization while only acceptance criteria need disjoint ownership, so the shared requirement is valid and rejecting it blocks a valid cross-repository plan.
- **Remove the finalization-carrying check entirely.** Declined: a slice must never claim a finalization acceptance criterion, which would double-assign root-owned verification, so the disjointness check on acceptance criteria is retained.
- **Enforce disjointness across both requirements and acceptance criteria by duplicating requirement IDs.** Declined: it would force artificial ID duplication and break exact plan coverage without adding assurance beyond the acceptance-criteria boundary.

## Consequences

- A slice manifest now accepts a requirement shared with `workspace_finalization` while still rejecting a shared finalization acceptance criterion, and the correction is one predicate in `src/workflow/workspace.ts`.
- The corrected rule matches `templates/skills/planning/references/plan.md`, which already states that finalization criteria are disjoint from every task's acceptance criteria and that child subsets remain exactly their tasks, and `MEMORY.md` records the same standard.
- Verification: with the predicate reverted the two regressions failed (2 failed, 36 passed of 38) with `Slice manifest must not carry workspace_finalization criteria`; with the fix `pnpm exec vitest run tests/integration/plan-workspace-cli.test.ts tests/integration/workspace-distribute-cli.test.ts` passed (38 passed, 2 files) and `pnpm typecheck` passed.
- Deployment: Git Operator returned the six tracked and three new files byte-exact into the source `/Users/yuqiyu/AiHistorys/ai-workflow` while leaving them unstaged and the source `main` `HEAD` `ed348bab9605587f1be87cfb670f773ade6c9a32` unchanged; `pnpm install` reported the dependencies and lockfile already up to date, `pnpm build` (`tsc -p tsconfig.build.json`) succeeded, and the PATH CLI `ai-workflow --version` reports `0.1.0` matching `package.json`. The wrapper `/Users/yuqiyu/.local/bin/ai-workflow` executes `/Users/yuqiyu/AiHistorys/ai-workflow/dist/cli.js`, so the local CLI now carries the corrected predicate.
- Real ISP verification: through the PATH CLI, all three `ai-workflow plan validate --plan <absolute-plan-directory>` commands returned `valid: true` for the parent `/Users/yuqiyu/Work/integrated-service-platform/isp/isp-data/.ai-workflow/plans/20261012-data-platform-production-remediation` and its center and sync children; all three keep the same original `spec` digest `437592473222eb5c920ef37f54e59765a13ca0c1a7003a4ecb1c8d2b40e62352` and `plan` digest `25ba844812e2a8c10e7ffdae44ddd3f689a539238a589f59ba33388f8d5dc25c` (parent 11 phases, center 6, sync 4). `ai-workflow workspace distribute --plan <parent>` returned `valid: true` with both slices unchanged, and `ai-workflow workspace status --plan <parent>` returned `valid: true` with both slices present at phase 1 with pending task `W1` and all implementation records missing, so no implementation started. This record claims no ISP implementation or production gate, and the source fix remains uncommitted as authorized.
- This record corrects the finalization-sharing detail referenced by [the parent workspace coding orchestration record](../feature/2026-10-09-workspace-coding-orchestration.md), [the submodule workspace delivery record](../architecture/2026-09-30-submodule-workspace.md) and [the workspace execution consistency record](./2026-10-08-workspace-execution-consistency.md); each keeps its decision, rationale and evidence limits, and no active record is superseded in full.
