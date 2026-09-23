# Agent Note: Project-local worktree policy

Status: implemented

[English](2026-09-14-project-local-worktree-policy.md) | 中文

## Problem

`coding` skill 最初要求每个编码执行单元都使用临时工作树，这与项目模板中 “one project-local temporary worktree” 的指令以及该 skill 自身的合并与清理生命周期一致。提交 `66927a3` 把这条要求弱化为可选项（“For larger or high-risk changes, consider a temporary worktree before implementation.”）。

这一措辞与项目模板仍然声明的 “one project-local temporary worktree” 相矛盾，也与 skill 自身保留的生命周期相矛盾：merge、rerun 与 cleanup 步骤仍作用于 temporary branch 与 owned worktree。由于执行时把工作树当作可选，编码运行会跳过它，随后就没有项目内工作树可用于实现、验证、提交、合并或清理，结果是 skill 与模板之间的执行方式不一致。

## Decision

编码在实现之前必须创建一个项目内临时工作树。Git Operator 在 `<project>/.worktrees/<name>` 创建它，项目 `.gitignore` 必须包含 `.worktrees/`，使该工作树保持未跟踪。

所有实现、验证与分步提交都在这一个工作树内进行。这是每个编码执行单元的强制步骤，而不是只留给高风险变更的选项；planning、TDD 与 review 的深度仍与变更风险成比例。临时分支与所属工作树只通过既有的 merge 与 cleanup 生命周期合并回主线并删除。

该决定仍然现行：工作树强制要求目前由项目契约 `.ai-workflow/AGENTS.md`（单源于 `templates/project/AGENTS.md`）、`coding` skill、`git-operator` 角色与 `MEMORY.md` 共同声明。原记录提到的项目级 `AGENTS.md`/`CLAUDE.md` 模板已由 [项目契约与 Agent Notes 替代记录](./2026-09-16-project-contract-and-agent-notes.md)取代，规则本身未改变。

## Alternatives considered

- **保持工作树可选（按比例）。** 否决：它破坏模板 “one project-local temporary worktree” 的约定，并让 skill 的 merge 与 cleanup 生命周期没有可操作对象。
- **放宽项目模板，让工作树也变为可选。** 否决：这会让每次编码运行都失去工作树隔离，并且是削弱安装期契约及其测试，而不是恢复一致性。

## Consequences

- `coding` skill 与项目契约现在声明同一条强制工作树规则，消除了 `66927a3` 引入的矛盾。
- 每个编码执行都被隔离在项目内工作树中，因此分步提交以及随后的 merge 与 cleanup 步骤总有工作树和分支可操作。
- `.worktrees/` 必须存在于项目 `.gitignore`；缺失条目是实现前需要修复的配置缺陷。
- planning、TDD 与 review 深度的比例性不变，只有工作树本身变为强制。
