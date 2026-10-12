# Agent Note: System proxy for template source

Status: implemented

[English](2026-10-12-system-proxy-template-source.md) | 中文

## Problem

默认的模板获取运行器只把进程环境复制进浅 `git clone`，因此一台通过已启用的系统 HTTPS 或 SOCKS 代理访问网络、却没有导出代理变量的 macOS 机器会以 TLS 或连接错误导致克隆失败。根本的代码缺口是运行器忽略了操作系统的静态代理配置，除非调用方已经将其导出，而仅在终端 `export` 永远不会到达由 GUI 启动的进程。原始用户可见的 TLS 错误是瞬时的，因此无法确凿地归因于环境。

## Decision

- `src/sync/source.ts` 把 `defaultGitRunner` 中的系统代理查询限制在克隆操作：它从 `{ ...process.env, GIT_TERMINAL_PROMPT: '0' }` 出发，并仅在 `darwin` 上、且 `https_proxy`、`HTTPS_PROXY`、`all_proxy`、`ALL_PROXY` 均无有效非空值时查询操作系统。
- 该查询以 2000 ms 的 `systemProxyTimeoutMs` 上界运行 `scutil --proxy`。已启用且 `HTTPSProxy`/`HTTPSPort` 有效的静态 `HTTPSEnable` 被复制为 `https_proxy=http://host:port`（CONNECT），否则已启用的 `SOCKSEnable` 变为 `all_proxy=socks5h://host:port`，IPv6 字面量加方括号；其他结果不添加任何内容。
- `scutil` 缺失、失败、超时或禁用、主机缺失或为空、或端口无效时返回 `{}`，让子环境保持普通 Git 所见的样子。显式代理变量始终优先并完全跳过查询；调用方的 `no_proxy`/`NO_PROXY` 及所有其他变量被保留。
- 改动仅限于默认运行器的子环境：注入的 `GitRunner` 不受影响，不写入任何全局环境变量、Git 配置或主机设置，不硬编码端口，也不新增 CLI 或 API 选项。固定的公共 URL、不可变的 40 位十六进制提交钉、五成员快照校验、`finally` 清理以及真实获取失败到 `unverified` 均保持不变。

## Alternatives considered

- 让用户在终端导出代理。放弃原因：由 GUI 启动的 agent 进程不会继承仅存在于 shell 的导出，因此失败会恰好对需要它的用户再次出现。
- 设置机器级或 Git 级代理。放弃原因：它把不相关的仓库和工具耦合到同一个主机与端口，并比本次获取存在得更久。
- 改用其他获取机制，或为克隆增加重试、开关或凭据。放弃原因：固定的公共浅克隆本就不带配额或凭据面；缺口只是环境路由。

## Consequences

- 处于已启用系统代理之后的 macOS 用户无需导出变量即可完成模板获取，而拥有显式代理变量的用户仍保有完全控制。
- 该行为仅限 macOS 且仅限默认运行器；不受支持的代理配置，包括仅 PAC 的设置，仍回退到普通 Git 行为，因此本记录不声称获取永远不会失败，也不声称支持每一种代理。
- `tests/unit/project-template-source-network.test.ts` 通过真实的 `git` 与 `scutil` 子进程垫片覆盖十二个操作系统边界用例（系统 HTTPS、四个显式变量、绕过变量保留，以及禁用/缺失/失败/无效/仅 SOCKS 的 IPv6/Linux 直连路径），且 `src/sync/source.ts` 由七文件/70 测试的定向运行、`tsc --noEmit` 与仓库配置的 ESLint 验证。
- 一次真实的构建后冒烟刷新了已安装的 `ai-workflow` CLI：在六个已导出的代理变量全部显式取消设置的情况下，`ai-workflow sync` 针对一个真实的 OneSpace 项目返回 `synchronized`、`verified: true`、`proceed: true`、来源提交 `569fac450b23d74eb9e0262a91e1fe7e05ebb4fb`，且无警告或冲突；自动 `sync-hook --phase` 运行返回 `decision: allow` 与相同的已验证报告；一次在 `PATH` 上没有 git 或 scutil 的原生 OpenCode `PreToolUse` 重放同样返回 `decision: allow` 与那份已验证的缓存报告，取代了缓存中的旧警告。
- 本记录补充[公共 git 模板来源](../simplification/2026-10-09-public-git-template-source.md)的传输路由；该记录仍解释无配额与无认证获取，而本记录增加 macOS 环境转换。没有任何先前决策被取代。
