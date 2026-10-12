# Agent Note: System proxy for template source

Status: implemented

English | [中文](2026-10-12-system-proxy-template-source.zh.md)

## Problem

The default template acquisition runner copied only the process environment into the shallow `git clone`, so a macOS machine that reaches the network through an enabled system HTTPS or SOCKS proxy but does not export proxy variables failed the clone with a TLS or connection error. The root code gap was that the runner ignored the operating system's static proxy configuration unless the caller had already exported it, and a terminal-only `export` never reaches a GUI-launched process. The original user-visible TLS error was transient, so it cannot be conclusively attributed to the environment.

## Decision

- `src/sync/source.ts` limits the system-proxy lookup in `defaultGitRunner` to clone: it starts from `{ ...process.env, GIT_TERMINAL_PROMPT: '0' }` and, on `darwin` only, consults the operating system when none of `https_proxy`, `HTTPS_PROXY`, `all_proxy` or `ALL_PROXY` carries a non-empty value.
- The lookup runs `scutil --proxy` with a 2000 ms `systemProxyTimeoutMs` bound. An enabled static `HTTPSEnable` with a valid `HTTPSProxy`/`HTTPSPort` is copied as `https_proxy=http://host:port` (CONNECT), otherwise an enabled `SOCKSEnable` becomes `all_proxy=socks5h://host:port` with IPv6 literals bracketed; any other result adds nothing.
- A missing, failing, timing out or disabled `scutil`, a missing or empty host, or an invalid port returns `{}` and leaves the child environment as ordinary Git would see it. Explicit proxy variables always take precedence and skip the lookup entirely; caller `no_proxy`/`NO_PROXY` and every other variable are preserved.
- The change is confined to the child environment of the default runner: injected `GitRunner`s are untouched, no global environment variable, Git configuration or host setting is written, no port is hardcoded, and no CLI or API option is added. The fixed public URL, immutable 40-hex commit pin, five-member snapshot validation, `finally` cleanup and genuine acquisition failure to `unverified` stay unchanged.

## Alternatives considered

- Tell the user to export the proxy in the terminal. Declined because a GUI-launched agent process does not inherit shell-only exports, so the failure reappears for exactly the users who need it.
- Set a machine-wide or Git-wide proxy. Declined because it couples unrelated repositories and tools to one host and port and outlives the acquisition.
- Use a different fetch mechanism, or add retries, flags or credentials to the clone. Declined because the fixed public shallow clone already carries no quota or credential surface; the gap was only environment routing.

## Consequences

- A macOS user behind an enabled system proxy can complete template acquisition without exporting variables, while a user with explicit proxy variables keeps full control.
- The behavior is macOS-only and limited to the default runner; an unsupported proxy configuration, including a PAC-only setup, still falls back to ordinary Git behavior, so this record claims neither that acquisition can never fail nor that every proxy is supported.
- `tests/unit/project-template-source-network.test.ts` covers twelve OS-boundary cases (system HTTPS, the four explicit variables, bypass preservation, and the disabled/missing/failed/invalid/SOCKS-only-IPv6/Linux direct paths) through real `git` and `scutil` subprocess shims, and `src/sync/source.ts` was validated by the targeted seven-file/70-test run, `tsc --noEmit` and the repository-configured ESLint.
- A real post-build smoke refreshed the installed `ai-workflow` CLI: with all six exported proxy variables explicitly unset, `ai-workflow sync` against a real OneSpace project returned `synchronized`, `verified: true`, `proceed: true`, source commit `569fac450b23d74eb9e0262a91e1fe7e05ebb4fb` and no warnings or conflicts, the automatic `sync-hook --phase` run returned `decision: allow` with the same verified report, and a native OpenCode `PreToolUse` replay with no git or scutil on `PATH` also returned `decision: allow` with that verified cached report, replacing the cached old warning.
- This supplements the transport routing of [Public git template source](../simplification/2026-10-09-public-git-template-source.md); that record still explains the no-quota and no-auth acquisition, while this one adds the macOS environment translation. No prior decision is superseded.
