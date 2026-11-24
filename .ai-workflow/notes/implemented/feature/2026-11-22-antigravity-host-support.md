# Agent Note: Antigravity as a fourth native host

Status: implemented

English | [中文](2026-11-22-antigravity-host-support.zh.md)

## Problem

`Host` and every host-accepting CLI surface knew only `codex`, `claude` and `opencode`. A user running Antigravity CLI (`agy`) could not install the workflow at all: no role agents were rendered, no synchronization entry was registered, `sync-hook`, `doctor` and `host smoke` rejected the host name, and profiles had no way to express Antigravity's model tiers. Antigravity discovers its own configuration from personal locations, so an adapter had to be designed against its native formats rather than against assumptions carried from the three existing hosts.

## Decision

Antigravity joins `Host` in `src/workflow/types.ts` as a fourth supported host, and native host integration in `src/install/render.ts`, `src/install/hooks.ts`, `src/install/index.ts`, `src/install/verify.ts`, `src/sync/gate.ts`, `src/cli.ts`, `src/ops/doctor.ts` and `src/host/smoke.ts` delivers it instead of a host-specific plugin or a second skill tree.

- Role agents are Antigravity-native Markdown `<role>.md` files under `~/.gemini/config/agents/` with `name`, `description`, `tools`, `subagent: true`, `mainAgent: false` and an optional `model` tier. The template vocabulary maps `read` to `read_file`, `edit` to `edit_file` and `write_file`, `shell` to `run_command` and `manage_task`, `web` to `search_web`, and `search` to `run_command` and `manage_task`, deduplicated in order, and no rendered role receives a nested-dispatch tool.
- Skills remain single-sourced under `~/.agents/skills/`. Antigravity reaches them through exactly one owned entry in `~/.gemini/config/skills.json` carrying the absolute `<home>/.agents/skills` path and a sorted `include_only` list, so nothing is copied or symlinked under `~/.gemini/` and unrelated skills in the shared tree stay invisible to Antigravity.
- `~/.gemini/AGENTS.md` carries the single-source loading block from `templates/contract/AGENTS.md`, and `~/.gemini/GEMINI.md` is never created, read or modified.
- `~/.gemini/config/hooks.json` holds one owned top-level key `"ai-workflow-sync"` with `SessionStart`, `PreInvocation` and `PreToolUse` (matcher `*`). The installer never writes `enabled`, preserves unrelated keys, reports a user's own `enabled: false` as `disabled` without rewriting it, preserves an unowned or hand-modified key in `skipped`, and uninstall removes only that key, deleting the file only when the installation created it and nothing but an empty object remains.
- `sync-hook --host antigravity` consumes camelCase `hookEventName`, `conversationId`, `cwd`, optional `invocationNum` and optional `toolCall`. `allow` injects `injectSteps.systemMessage` on `SessionStart` and on `PreInvocation` only when `invocationNum` is omitted or `0`, and `{}` above that. `deny` returns the `SessionStart` context plus its follow-up note, `injectSteps.errorMessage` with `terminationBehavior: "terminate"` on `PreInvocation`, and `{"decision":"deny","reason":...}` on `PreToolUse`. A permitted or skipped `PreToolUse` writes zero bytes.
- The gate exempts the exact contract `read_file` (`Path`) and the synchronization actor's `run_command` (`CommandLine`), matching the exemptions it already applies to the other hosts.
- `schemas/profile.schema.json` accepts `antigravity.model` only as the closed tier enum `inherit`, `flash_lite`, `flash` and `pro`; `inherit` omits the key from the rendered agent. `reasoning_effort` is accepted by the schema, never rendered, and reported by `activateProfile` as a non-blocking activation warning.
- `agy` is the Antigravity executable for `doctor` readiness, which always reports `warn` because a read-only check verifies neither authentication nor trust, and for `host smoke`, which runs `agy --version` and `agy -p <prompt> --mode plan`.
- A role that declares a shell tool also renders `commandExecutionPolicy: auto`, so routine project git, build and test commands run without repeated approval while Antigravity's permission engine still gates irreversible actions.
- `runProjectGate` compares a stored allow result with pending `created` or `updated` managed paths against the native `workspacePaths`. When the actual root lies outside every mounted workspace, it returns a deny with the exact `/add-dir <root>` recovery before the Git Operator can wait on a non-workspace approval, and the Git Operator packet rule independently stops before any out-of-workspace read or Git command.

## Alternatives considered

- Packaging the workflow as an Antigravity plugin under `~/.gemini/config/plugins/`. Declined because Antigravity namespaces plugin skills as `<plugin>:<skill>`, which breaks every unprefixed skill reference the shipped prompts use, and because a plugin duplicates skills instead of keeping `~/.agents/skills/` as the single physical source.
- Copying or symlinking skills into `~/.gemini/config/skills/`, `~/.gemini/skills/` or `~/.gemini/antigravity-cli/skills/`. Declined because copies drift across hosts, `~/.gemini/skills/` is CLI-only, and symlink traversal is undocumented, while `skills.json` with `include_only` is documented, shared by CLI and App, and keeps one source.
- Registering Antigravity hooks as bare top-level event keys. Declined because bare keys cannot be owned or refreshed without colliding with user entries; a single named key gives install refresh, unowned preservation and precise uninstall.
- Writing `enabled: true` in the owned hook. Declined because the value cannot be verified, so it would misreport activation and could overwrite a deliberate user disable.
- Returning `{}` or `{"decision":"allow"}` for a permitted `PreToolUse`. Declined because `agy` treats `{}` as a denial and auto-approves on `{"decision":"allow"}`, which would bypass user permission prompts; empty stdout passes without overriding them.
- Accepting concrete Antigravity model IDs in profiles. Declined because an unsupported ID fails silently at agent load time, and a closed tier enum rejects it before any write.
- Auto-approving every Antigravity tool or setting `allowNonWorkspaceAccess` from the installer. Declined because it would remove the host's permission boundary for unrelated work; only the role-scoped `auto` policy is granted, and out-of-workspace access stays a user decision.
- Deferring the maintenance commit to the coding phase. Declined because `created` and `updated` describe only the files a phase entry wrote; a later phase entry sees already-current files and would not report the pending paths, so the dirty managed files could reach the worktree without a recorded commit.

## Consequences

- Installation, uninstallation, verification, `doctor` and `host smoke` accept `antigravity`, and `--host all` covers all four hosts; manifests stay backward compatible because `skills_manifests` and the `named_hook` synchronization record are additive and optional.
- Antigravity loading is reported as installed but unverified until an actual session runs; a disabled, unowned or hand-modified hook or manifest entry is named rather than silently approved.
- A phase whose pending managed-file commit targets a root outside the mounted workspace now fails immediately with the exact `/add-dir` recovery instead of timing out after 60 seconds; after the root is mounted, the stored phase result and the role-scoped `auto` policy let the same session retry the commit without repeated approval.
- The three user-global loading, synchronization and shared-skill mechanisms this host reuses are described in the [user-level agent contract record](../architecture/2026-09-14-user-level-agent-contract.md), the [project template synchronization record](2026-10-08-project-template-sync.md), the [single-start cadence record](2026-10-09-sync-once-at-skill-start.md) and the [review evidence and shared skills record](../process/2026-11-05-review-evidence-and-shared-skills.md); each remains active because its own rationale, alternatives and coverage limits still apply unchanged.
- `tests/behavior/antigravity-agent-contract.test.ts` guards rendering, tool mapping and the install boundary, while `tests/install/sync-hooks.test.ts`, `tests/integration/project-sync-hooks.test.ts` and `tests/integration/global-agent-guidance.test.ts` cover hook ownership, the native protocol and the contract block. The four-host native parent-session trace remains an explicitly reported gap rather than a claimed pass.
