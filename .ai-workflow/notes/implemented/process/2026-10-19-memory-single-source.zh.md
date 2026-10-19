# Agent Note: MEMORY single-sources the workflow contract

Status: implemented

[English](2026-10-19-memory-single-source.md) | 中文

## Problem

根 `MEMORY.md` 曾膨胀到复述项目的工作流契约，同一条规则因此同时存在于两处。固定上下文的读者无法判断哪一份副本才是权威，而一次只更新其中一份副本的变更会让另一份继续描述较旧的规则。`.ai-workflow/AGENTS.md` 中的项目契约与 `.ai-workflow/notes/README.md` 中的笔记治理已经拥有这些通用工作流规则，因此这些复述只增加了维护成本与漂移风险，并未增加一条不同的标准。

## Decision

- **每条工作流规则只有一个权威归属。** 根 `MEMORY.md` 只记录项目当前的产品、仓库与元标准及其行为。每条工作流规则都委托给它唯一的归属：`.ai-workflow/AGENTS.md` 中的项目契约与 `.ai-workflow/notes/README.md` 中的笔记治理。
- **恰好一条指针标准。** `MEMORY.md` 携带一条工作流权威指针，同时指明 `.ai-workflow/AGENTS.md` 与 `.ai-workflow/notes/README.md`，并说明工作流契约存放在那里，而非在 `MEMORY.md` 中复述。
- **保留的项目标准。** 产品与仓库事实、已发布表面事实以及两条元标准保留在 `MEMORY.md` 中，因为它们描述的是本项目，而不是通用的工作流契约。
- **相关的当前状态规则。** 本决定建立在 [memory-governance 记录](2026-10-19-memory-governance.md) 所记录的仅记录当前状态的纪律之上；该记录拥有 `MEMORY.md` 如何保持最新的规则，而本记录拥有每条规则位于何处。

## Alternatives considered

- **保留这些复述。** 已否决：重复的工作流规则会漂移，而且固定上下文的读者无法区分权威副本与过时副本。
- **把所有标准都迁入契约。** 已否决：保留的产品与仓库事实属于项目自身，若通过生成的契约镜像发布，会把项目特定的事实带入采用者的模板。
- **把本决定并入 memory-governance 记录。** 已否决：治理记录拥有当前状态规则，而委托边界是一项单独的决定，因此把它记录为一条链接到先前记录的新笔记。

## Consequences

- 每条工作流规则都只有一个权威归属，因此变更只需更新一个表面，而无需手工让 `MEMORY.md` 与契约保持同步。
- `MEMORY.md` 作为项目当前标准文档被读取，并保持更短，而契约与笔记治理继续拥有它们已经描述的工作流规则。
- 本次变更合并后，在本仓库下一次 planning、coding 或 plan-to-tasks 技能启动前，必须把 `main` 推送到 `origin`：同步预检会用上游快照替换 `.ai-workflow/AGENTS.md`，否则会把已修正的镜像还原。
- 一个行为测试断言根 `MEMORY.md` 中的单条指针、保留的事实以及被委托工作流主题的缺席。
