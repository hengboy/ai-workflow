# Agent Note: Public git template source

Status: implemented

English | [中文](2026-10-09-public-git-template-source.zh.md)

## Problem

Anonymous template acquisition used the GitHub contents API, whose unauthenticated limit is 60 requests per hour shared per IP. A single complete synchronization check issued about fourteen requests to resolve the branch, list each supported directory and read each supported file, so a few skill starts within one hour exhausted the shared budget and a mid-check `403` surfaced as an `unverified` warning with `verified: false`. A token was only an optional mitigation, and it added credential-file discovery, `GH_TOKEN`/`GITHUB_TOKEN` precedence and an explicit bearer header to a read-only documentation check.

## Decision

- `resolveTemplateSnapshot` in `src/sync/source.ts` acquires the current templates with a shallow temporary clone — `git clone --depth 1 --branch simplify https://github.com/hengboy/ai-workflow.git` into a throwaway `mkdtemp` directory — and `rev-parse HEAD` pins the single immutable 40-hex commit.
- The nine supported `templates/project` files are read from that clone and validated per file for identity, encoding, size, ownership-marker structure and the archive-manifest shape, and the temporary directory is removed in a `finally` block before the snapshot returns.
- Acquisition reads no token and no credential file and uses no GitHub CLI or SSH configuration, so it carries no API quota and no credential surface, and `GIT_TERMINAL_PROMPT=0` keeps a non-interactive clone from prompting.
- A `GitRunner` injection seam (`runGit` on `SynchronizeProjectOptions` and `ProjectGateOptions`) replaces the old `fetch`/`env` options so tests drive acquisition without the network.
- Failure semantics are unchanged: a failed or incomplete acquisition leaves every target byte unchanged and reports `unverified` with `verified: false`, `proceed: true` and a visible warning.

## Alternatives considered

- Keep the GitHub contents API and send a token. Declined because the read-only documentation check would still carry credential precedence, credential-file discovery and quota coupling, and a token only raised the ceiling rather than removing the failure mode.
- Fetch each file from `raw.githubusercontent.com`. Declined because it keeps one network round trip per file with no atomic commit pin, so a partial or moving read could pass structural validation without a single immutable source.
- Use the SSH git address. Declined because it reintroduces host-key, agent and key-file handling for a public, read-only source.
- Fetch into a temporary bare repository and `git show` each file. Declined because a shallow working-tree clone is simpler, still pins one commit, and reads files directly without per-file plumbing.

## Consequences

- Synchronization no longer depends on GitHub API quota or any credential, so repeated skill starts cannot exhaust a shared request budget.
- Acquisition now depends on the `git` executable and network access; a missing git or an unreachable remote fails exactly as before, to `unverified` with zero target writes.
- Every check performs a fresh shallow clone with no cache, trading a small clone cost for an always-current, single-commit source.
- The `GitRunner` seam and a PATH `git` shim in `tests/helpers.ts` cover both the injected-runner unit path and the real subprocess integration path.
- This partially supersedes the acquisition decision in [Project template synchronization](../feature/2026-10-08-project-template-sync.md); that record now describes the shallow public clone in place, while its merge, marker, report and preservation contracts stay current.
