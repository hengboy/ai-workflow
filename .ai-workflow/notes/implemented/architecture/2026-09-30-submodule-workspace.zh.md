# Agent Note: 子模块工作区交付

Status: implemented

[English](2026-09-30-submodule-workspace.md) | 中文

## Problem

跨多个仓库的变更既没有登记边界，也没有持久的跨仓库流程。单项目计划假定只有一个仓库根：发现会扫描其下的每个目录，任务依赖同一张图内的任务，一份实施记录覆盖整个计划，一次最终提交落在一个仓库。当一个根以本地 git 子模块组合子仓库时，这一模型会把子仓库代码读进父索引，让任务、作用域和笔记悄悄跨越仓库边界，也没有办法排列子仓库的交付顺序或钉住多仓库变更产生的提交。

## Decision

- git 子模块工作区根冻结一份跨仓库的 `spec.md`/`plan.md` 对，其 `workspace_repos` frontmatter 声明参与的仓库、它们相对工作区根的路径和仓库级交付顺序，`workspace.yaml` 清单则把每个任务恰好分配给一个仓库。
- `.gitmodules` 是唯一的边界信号：声明的子模块路径从工作区根的导航发现与校验中排除；既有工作区导航保持其字节不变，直到 `ai-workflow context rebuild --project <root> --write` 刷新该对；`context validate` 对每个被索引的子模块路径报告该指令，而没有 `.gitmodules` 的项目保持原有的发现与校验行为。
- `ai-workflow workspace distribute --plan <directory>` 在写入任何内容之前先通过只读 Git 前置检查（`git -C <repo> symbolic-ref -q HEAD` 与 `git -C <repo> status --porcelain`）校验每个参与仓库，拒绝有分歧的切片文件，然后把自包含切片——冻结的规划三元组、该仓库的任务三元组、其过滤后的执行顺序和 `slice` 清单——写入每个参与仓库，并跳过保留的 `workspace` 根条目，根自身的任务留在根计划中。
- 每个仓库在自己的会话中实现自己的切片，拥有自己的 worktree、校验、实施记录和交付提交，且它的任务绝不依赖另一个仓库中的任务。
- `ai-workflow workspace status --plan <directory>` 以只读方式、按交付顺序报告且不写入：每个仓库的切片存在状态、实施记录状态和交付提交，以及下一个仓库和所有切片是否完成；它仅通过文件系统检查工作区树，不运行任何 Git。
- 所有切片完成后，根用只读 Git 在其源仓库中校验每个记录的交付提交，并在工作区 worktree 内用 `git update-index --cacheinfo 160000,<sha>,<path>` 钉住每个受影响的子模块，只暂存授权的 pointer 路径和工作区根文件。工作区根拥有跨仓库决策笔记，每个仓库拥有覆盖其实际交付事实的笔记，跨仓库引用保持纯 plan-ID 文本。

## Alternatives considered

- **检测已登记子模块之外的多仓库拓扑。** 放弃：只有 `.gitmodules` 提供显式的边界信号；从目录布局、嵌套 checkout 或扫描推断参与关系，会把无关的内嵌目录树当作参与仓库，并让边界变成隐式的。
- **让任务依赖另一个仓库中的任务。** 放弃：任务级跨仓库依赖会把一个切片的执行耦合到另一个仓库的 worktree、记录和提交顺序，因此调度保持在仓库粒度、按声明的 `workspace_repos` 顺序进行，任何任务都不依赖另一个仓库。
- **在工作区导航中索引子仓库代码。** 放弃：子仓库状态属于子仓库自己的导航；在根中索引它会让两个索引对同一批文件和符号拥有重叠的所有权，并让任一侧的刷新使另一侧失效。
- **自动或远程编排子会话。** 放弃：工作流运行本地会话，因此分发把切片交接给某个仓库，由该仓库自己的会话实现；一个启动、排程或远程驱动会话的编排器会增加不受支持的运行时表面并掩盖仓库边界。
- **在分发或状态期间改动 Git。** 放弃：分发写文件、状态检查状态，因此二者保持可重复且无副作用；隐藏的提交、checkout 或分支会使它们不再幂等，并绕过 Git Operator 入口，而项目契约声明的显式例外覆盖分发与交付提交校验中的只读 Git，不包括状态。
- **迁移历史计划或导航。** 放弃：在边界存在之前写出的工作区导航只能通过 `ai-workflow context rebuild --write` 刷新，而没有 `workspace_repos` 的历史计划保持其字节和原有行为；自动迁移会重写用户尚未评审的冻结内容或被索引内容。

## Consequences

- 切片是每个仓库 `.ai-workflow/plans/<planId>/` 下被 gitignore 的本地工件，与普通冻结计划完全一样，因此既有的忽略状态物化规则在每个参与仓库内原样适用。
- 交付提交通过工作区 worktree 钉住：工作区流程中唯一的 Git 变更就是 Git Operator 执行的最终 pointer 提交，提交校验会把每个生成的 pointer 与记录的交付 SHA 比较。
- 钉住之后移动子模块 checkout 不在范围内，且 pointer 提交只引用本地可用的交付提交，因此远程操作不在范围内。
- 既有工作区导航在显式重建之前保持字节不变，没有 `.gitmodules` 的项目保持其发现、校验和命令不变；工作区声明、任务 `repo` 字段、`workspace.yaml` 与两个工作区命令都是附加的。
- 没有任何活动记录被整体或部分取代：[worktree 政策记录](../process/2026-09-14-project-local-worktree-policy.md) 与 [忽略状态共享记录](../process/2026-09-14-share-ignored-state-into-worktree.md) 保持有效，因为工作区流程在 worktree 内运行且仅以只读方式读取工作区树，而 [任务执行顺序记录](../process/2026-09-25-task-execution-order.md) 与 [实施记录](../process/2026-09-22-plan-implementation-record.md) 按仓库保持其规则；本记录只增加跨仓库层。
