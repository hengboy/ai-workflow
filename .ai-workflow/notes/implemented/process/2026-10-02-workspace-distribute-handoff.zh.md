# Agent Note: 工作区拆分分发交接

Status: implemented

[English](2026-10-02-workspace-distribute-handoff.md) | 中文

## Problem

跨仓库的工作区计划可能在切片尚未写出时就完成拆分：只有在有人显式运行 `ai-workflow workspace distribute --plan <directory>` 时，才把切片交接给每个参与仓库，而 `planning`、`plan-to-tasks` 和 `coding` 技能都没有要求或检查这一步。因此编码会话可能从一个未分发的跨仓库计划开始，为一个没有任何参与仓库收到的任务创建工作树和实施记录。这些技能也没有区分声明了参与子仓库的工作区计划与只声明保留 `workspace` 根条目的工作区计划，于是仅根条目的计划有被强制拆分之虞，而真正的跨仓库计划却没有闸门。没有任何规则要求拆分会话报告每个仓库的切片状态，参与仓库中的会话对于没有切片清单的计划目录也没有规则。

## Decision

- 声明至少一个非根参与仓库的工作区计划必须由 plan-to-tasks 在实现前拆分，完成该拆分要在任务三元组、其配对记录与 `workspace.yaml` 写出且最终的 `ai-workflow plan validate --plan <directory>` 通过之后运行 `ai-workflow workspace distribute --plan <directory>`。
- 拆分报告每个参与仓库的切片状态和保留的 `workspace` 根条目；当分发因有分歧的切片、未满足的仓库前置条件或无效清单而拒绝时，拆分报告确切的错误和修复指令，声明计划尚未可供编码且已写出的任务工件保持原位，并且只有在之后的成功分发后才完成交接。
- 编码入口在任何工作之前用 `ai-workflow workspace status --plan <directory>` 确认已分发的切片，并在创建工作树或实施记录之前拒绝未分发的跨仓库计划，指向 plan-to-tasks，或在拆分工件已存在时指向 `ai-workflow workspace distribute --plan <directory>`。
- 位于参与仓库中的编码会话，其计划目录没有切片 `workspace.yaml` 时，在创建工作树或实施记录之前停止，报告该仓库缺失清单，并把 `ai-workflow workspace distribute --plan <directory>` 命名为修复。
- `workspace_repos` 只声明保留 `workspace` 根条目的工作区计划保持可免拆分：它可以像单仓库计划一样实现，不要求也不尝试分发。
- 该规则由已发布的 `planning`、`plan-to-tasks` 和 `coding` 技能、`templates/project/AGENTS.md` 与 `.ai-workflow/AGENTS.md` 中的项目契约、`templates/project/MEMORY.md` 与 `MEMORY.md` 中的项目记忆，以及 `README.md` 共同声明。

## Alternatives considered

- **由规划会话分发。** 放弃：规划只拥有工作区根这一对文件，从不写切片，而分发需要拆分产出的任务三元组、配对记录和 `workspace.yaml`，因此它属于 `plan validate` 之后的拆分会话，而不属于规划。
- **只在编码入口分发。** 放弃：分发是拆分的完成步骤，把切片交接给每个参与仓库，若留给编码入口，会让各仓库会话争相分发并模糊拆分边界；编码入口只校验切片并在缺失时拒绝。
- **对跨仓库计划保持拆分可选。** 放弃：未拆分的跨仓库计划没有可校验的切片，也没有仓库级交接，因此让拆分保持可选会使未分发的计划进入实现，而这正是本规则要防止的缺陷。
- **把分发扩展到未拆分计划。** 放弃：分发定义在带有 `workspace.yaml` 和过滤后执行顺序的拆分计划上，而未拆分计划两者皆无，扩展它会增加第二条生成路径，而不是要求先拆分。

## Consequences

- 已安装的主机技能和代理是副本，因此该规则只有在下次主机安装或 profile 激活之后才到达日常会话；上线后的第一次跨仓库拆分是该交接的运行时观察。
- 没有 `src/`、CLI 或 schema 变更：`workspace distribute` 继续在写入任何内容之前以只读方式校验每个仓库并拒绝分歧和未满足的前置条件，`workspace status` 继续以只读方式报告，因此它们的行为不变。
- 拒绝路径是明确的：未分发的跨仓库计划和缺失的切片清单在创建工作树或实施记录之前停止，而分发拒绝会保留已写出的任务工件并报告确切的错误与修复，只有在之后的成功分发后才完成交接。
- 仅根条目和非工作区计划不变：仅根条目的工作区计划可以免拆分实现，而没有 `workspace_repos` 的计划保持其普通的单仓库流程。
- 没有任何活动记录被整体或部分取代。[子模块工作区交付记录](../architecture/2026-09-30-submodule-workspace.md) 保持有效，且未被重写、移动或归档：它的分发、状态和定稿事实仍然描述未改变的命令行为，本记录只在其周围增加拆分与交接闸门。
