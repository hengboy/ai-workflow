# Agent Note: MEMORY is current-state only

Status: implemented

[English](2026-10-19-memory-governance.md) | 中文

## Problem

`MEMORY.md` 已经漂移成了一份变更日志：诸如 "was removed"、"no longer" 与 "previously" 之类的表述描述的是被取代的旧状态，而不是项目今天遵循的标准。`MEMORY.md` 在每个会话开始时作为固定上下文被读取，因此一条历史性或过时的表述会被读作当前规则，读者无法区分仍然生效的标准与产生它的历史。Git 与 Agent Notes 已经保存了标准为何改变，而这个长期记忆文件此前没有让自身表述保持最新的同等纪律。

## Decision

- **仅记录当前状态。** `MEMORY.md` 只记录项目当前的标准与行为。取代某条表述的变更会在同一次变更中把它改写为当前状态或将其删除，因此已记录的标准会随变更落地而保持最新。
- **历史存放于他处。** 被取代的历史属于 Git 与 Agent Notes，绝不进入 `MEMORY.md`。关于不存在机制的缺失性表述，例如 "there is no `update` subcommand"，仍是合法的当前事实，而诸如 "are removed" 或 "was removed" 之类的叙述性差异则不是。
- **同一次变更的义务。** 落地替代内容的变更负责改写它所取代的那条表述，而 Documentation Maintainer 把这一点作为硬性门槛，使 `MEMORY.md` 与笔记在同一次变更中保持一致。
- **发布载体。** 该规则经项目契约的 `## Shared context and maintenance` 一节、`documentation-maintainer` 角色流程、初始化引导文件 `templates/project/MEMORY.md` 以及 `README.md` 的 `### MEMORY maintenance` 一节发布，因此采用该工作流的项目会经既有的同步路径获得它。
- **根记忆回到当前状态。** 本仓库自身的 `MEMORY.md` 被改写，使其保留的每条表述都描述当前项目状态，历史性措辞被当前标准替换。

## Alternatives considered

- **自动陈旧检查器。** 已否决：没有任何机械检查能判断一段文字是否仍然与当前行为相符，因此这样的扫描器要么误报正确的当前事实，要么漏掉真正的漂移，并且它会在文档之外新增命令与 schema 界面。
- **变更日志式 `MEMORY.md`。** 已否决：把历史作为追加条目保留，会把固定上下文的文档变成不断增长的日志，混入当前标准与被取代的内容，而这正是 Git 与 Agent Notes 的职责。
- **保持陈旧现状。** 已否决：读者会继续把历史性措辞误当作当前标准，而且没有任何同一次变更的义务来让该文件保持最新。

## Consequences

- `MEMORY.md` 在每个会话中都作为仅含当前状态的文档被读取，读者看到的是仍然生效的标准，无需过滤被取代的历史。
- 该规则经契约、角色、初始化引导文件与 `README.md` 发布，因此每当同步刷新这些文件时，采用该工作流的项目无需迁移即可获得它。
- 被取代的历史仍可从 Git 与 Agent Notes 取回，因此某条表述被改写时，其理由与先前状态不会丢失。
- 让 `MEMORY.md` 与笔记在同一次变更中保持一致，成为 Documentation Maintainer 可评审的义务，而不再是隐含的期望。
- 一个行为回归测试在每一个发布表面上断言该规则，并断言根 `MEMORY.md` 中不存在被禁的历史措辞。
