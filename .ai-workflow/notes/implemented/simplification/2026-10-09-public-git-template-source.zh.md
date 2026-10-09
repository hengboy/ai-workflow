# Agent Note: Public git template source

Status: implemented

[English](2026-10-09-public-git-template-source.md) | 中文

## Problem

匿名模板获取使用 GitHub contents API，其未认证限额为每个共享 IP 每小时 60 次请求。一次完整的同步检查会发出约十四次请求，用于解析分支、列出每个受支持目录并读取每个受支持文件，因此一小时内数次技能启动就耗尽了共享预算，检查中途的 `403` 会以 `verified: false` 的 `unverified` 警告形式暴露出来。令牌只是可选的缓解手段，却给一个只读的文档检查引入了凭据文件发现、`GH_TOKEN`/`GITHUB_TOKEN` 优先级以及显式 bearer 头。

## Decision

- `src/sync/source.ts` 的 `resolveTemplateSnapshot` 以浅临时克隆获取当前模板——`git clone --depth 1 --branch simplify https://github.com/hengboy/ai-workflow.git` 到一次性 `mkdtemp` 目录——并由 `rev-parse HEAD` 钉住唯一的 40 位十六进制不可变提交。
- 九个受支持的 `templates/project` 文件从该克隆中读取，并逐文件校验身份、编码、大小、所有权标记结构与归档清单形态，且在快照返回前于 `finally` 块中移除临时目录。
- 获取不读取任何令牌或凭据文件，也不使用 GitHub CLI 或 SSH 配置，因此不携带 API 配额与凭据面，且 `GIT_TERMINAL_PROMPT=0` 使非交互式克隆不会提示输入。
- `GitRunner` 注入缝（`SynchronizeProjectOptions` 与 `ProjectGateOptions` 上的 `runGit`）取代旧的 `fetch`/`env` 选项，使测试无需网络即可驱动获取。
- 失败语义不变：获取失败或不完整会使每个目标字节保持不变，并报告 `unverified`、`verified: false`、`proceed: true` 与可见警告。

## Alternatives considered

- 保留 GitHub contents API 并发送令牌。放弃原因：该只读文档检查仍会携带凭据优先级、凭据文件发现与配额耦合，而令牌只是提高了上限而非消除失败模式。
- 从 `raw.githubusercontent.com` 逐个拉取文件。放弃原因：它仍为每个文件保留一次网络往返且没有原子提交钉，因此部分或移动中的读取可能在没有单一不可变来源的情况下通过结构校验。
- 使用 SSH git 地址。放弃原因：它为公共只读来源重新引入了主机密钥、agent 与密钥文件处理。
- 拉取到临时裸仓库并用 `git show` 读取每个文件。放弃原因：浅工作树克隆更简单，仍钉住一个提交，并直接读取文件而无需逐文件管道。

## Consequences

- 同步不再依赖 GitHub API 配额或任何凭据，因此重复的技能启动无法耗尽共享请求预算。
- 获取现在依赖 `git` 可执行文件与网络访问；缺失 git 或远端不可达会与以前完全相同地失败为 `unverified`，且零目标写入。
- 每次检查都执行一次无缓存的全新浅克隆，以少量克隆成本换取始终最新、单一提交的来源。
- `GitRunner` 缝与 `tests/helpers.ts` 中的 PATH `git` 垫片同时覆盖注入运行器的单元路径与真实子进程集成路径。
- 这会部分取代[项目模板同步](../feature/2026-10-08-project-template-sync.md) 中的获取决策；该记录现在改为描述浅公共克隆，而其合并、标记、报告与保留契约仍然有效。
