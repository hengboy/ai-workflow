# Agent Note: 自动实施提交

Status: implemented

[English](2026-10-14-automatic-implementation-commit.md) | 中文

## Problem

派发有范围的本地提交本就已是要求：`coding` 技能要求会话每一步自检一次并为该有范围提交派发 Git Operator，契约的 Orchestration 一节要求 Documentation Maintainer 返回后派发 Git Operator。表述不足的是：一旦实施获得授权，委派就对 planned、direct 与 mechanical 工作自动发生，随后不需要单独的提交确认，且 `done` 以提交证据与 SHA 为门禁。缺少这些表述时，一次运行可以把变更呈现为已完成而把提交留待后续提示，且无范围差异的执行单元没有既定的无变更证据路径。

## Decision

- 项目契约 `templates/project/AGENTS.md` 及其纳入版本控制的 `.ai-workflow/AGENTS.md` 规定：一旦一次已授权实施通过其相关检查与任何适用的既有门禁，主编排器就自动把有范围的本地提交委派给 `git-operator` 子代理（Git Operator），覆盖 planned、direct 与 mechanical 变更，且无需单独的提交确认，并以结果提交 SHA 或以当前 HEAD SHA 的已验证无变更证据作为 `done` 的门禁。
- `coding` 技能的 `## Change routing` 把 direct 与 mechanical 的 worktree 和 Git Operator 提交接到该自动门禁上，其 `## Verification and Commit` 要求自动委派，同时保留评审时机与拆分阶段串行提交，其 `## Completion checklist` 以返回的提交 SHA、或在执行单元没有范围差异时以 Git Operator 对当前 HEAD SHA 的已验证无变更证据作为 `done` 的门禁，并把失败或被阻塞的提交报告为 `blocked` 或 `failed`。
- `git-operator` 角色只在 planned 工作时要求 plan/task ID，而对 direct 或 mechanical 变更以请求的显式有范围结果为边界，不索取缺失的 `spec.md`、`plan.md` 或 task 文件；它接受主代理已授权的自动提交包，无需新的用户确认，照旧携带有范围 diff 与证据调用已安装的 `$git-message` 技能，并返回提交 SHA；当不存在范围差异时，它核实这一点并返回带当前 HEAD SHA 的无变更证据，而不是伪造一次空提交。
- 提交这一要求属于实施完成，而非仅规划的会话：规划会话仍以其冻结计划交接结束，不启动实施或提交。
- `tests/behavior/change-routing.test.ts` 守护已发布的契约、coding 技能与 Git Operator 文本，因此若回归导致自动提交或提交支撑的 done 门禁被丢弃，测试套件会失败。

## Alternatives considered

- **在 direct 工作后保持提交可选或手动。** 放弃：可选提交会丢掉所需的收尾，因为一次运行可以报告完成而没有任何提交，用户仍须自行要求。
- **只对 planned 工作自动提交。** 放弃：对 planned、direct 与 mechanical 变更统一自动进行本地提交，遵循了既有的“三者都作为带 Git Operator 提交的单一编码执行单元执行”规则，因此按类区分会引入工作流本不作的区分。

## Consequences

- 一次已授权实施现在以通过 `git-operator` 子代理进行的有范围本地提交结束，或在没有范围差异时以带当前 HEAD SHA 的已验证无变更证据结束，且 `done` 要求该证据；失败或被阻塞的提交报告为 `blocked` 或 `failed`。这保留了既有的 `kind: no-change` 检查点边界，而不是强行产生一次空提交。
- [变更分流](./2026-09-22-change-routing.md)仍然有效：它负责 direct、mechanical 与 planned 分类及保留的执行单元，本记录只是把既有的 Git Operator 提交变为自动并以提交作为完成门禁。
- [规划与编码的会话边界](./2026-09-23-planning-coding-session-boundary.md)仍然有效：仅规划的会话仍以其交接结束，不启动实施或提交，因此本记录阐述的是实施完成，而不是重开该边界。
- 提交保持本地且不新增 Git 权限：该角色仍只暂存显式路径、调用 `$git-message`、保留无关改动且不进行远程变更。
