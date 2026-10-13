---
name: sync-ai-workflow
description: Synchronize an existing ai-workflow adoption's managed workflow instructions from upstream with the incremental CLI. Use for a manual, user-requested synchronization of an already adopted project.
---

# Sync ai-workflow

## Scope and cadence

Refresh managed workflow instructions from upstream only on an explicit user request for a project already containing `.ai-workflow/`. First adoption, installer setup, host reinstallation and a repo-wide upgrade stay with the setup-ai-workflow skill.

Automatic synchronization runs once at each planning, coding or plan-to-tasks skill session start via `--phase --project <actual-root>`, stores the complete result for the actual root outside the project, and serves every later native host event from that stored per-root result with no source request. This manual skill performs a fresh, cache-independent synchronization and never replaces the stored gate decision. Do not start the automatic check here.

## Project context

Before acting, explicitly read the project's `.ai-workflow/AGENTS.md`, `MEMORY.md`, `.ai-workflow/index/navigation.json` and `.ai-workflow/index/navigation.md`, or receive them through complete context injection. A Markdown link or an inherited parent read does not load them into this session. The project contract applies to the whole project and every participating agent.

## CLI and source

Run the installed `ai-workflow sync` CLI without building it. Templates come from a shallow temporary clone of the fixed public address `https://github.com/hengboy/ai-workflow.git`, branch `main`. There is no token, credential file, GitHub CLI or SSH configuration handling; the clone reads no secret and stores no credential. Never search credential files, invoke a GitHub CLI, or infer authentication from SSH configuration.

- `ai-workflow sync [project]` applies generated replacements and reports the result. An omitted project defaults to the actual current directory, normalized to its adopted root.
- `ai-workflow sync [project] --check` computes the same verdict and proposed changes without writing, including mtimes; use it to inspect pending changes before applying them.

A repeat against an identical snapshot is idempotent and changes nothing.

## File scope

The five generated workflow documents are replaced as complete files: differing files are overwritten with their entire source, including manual edits; absent files are created and identical files skipped.

| Source | Generated target |
| --- | --- |
| `templates/project/AGENTS.md` | `.ai-workflow/AGENTS.md` |
| `templates/project/notes/AGENTS.md` | `.ai-workflow/notes/AGENTS.md` |
| `templates/project/notes/README.md` | `.ai-workflow/notes/README.md` |
| `templates/project/notes/implemented/AGENTS.md` | `.ai-workflow/notes/implemented/AGENTS.md` |
| `templates/project/notes/archived/AGENTS.md` | `.ai-workflow/notes/archived/AGENTS.md` |

Root `MEMORY.md` is init-only and project-owned: synchronization never replaces, appends, normalizes or compares it against a template. Navigation, note bodies, the archive manifest and every other local or data artifact are preserved. Synchronization writes no product code, frozen plan or task file and performs no Git operation. Frozen planning artifacts are never synchronization input.

A generated target with legacy `ai-workflow:section` comment markers is refused as a `conflict` before any write and requires manual replacement instead of a merge. A local shipped-template upgrade reports visible `needs_attention` with an unverified local-source warning until markerless upstream is available.

## Report and decisions

Parse the manual CLI's `SyncReport`: `status`, `verified`, `proceed`, `check`, `created`, `updated`, `skipped`, `warnings` and `conflicts`, with no `decision` field. Truthfully report `status`, `verified` and `proceed` and act as follows:

| Status | Exit | Proceed | Action |
| --- | --- | --- | --- |
| `synchronized` | 0 | true | Success; freshness requires `verified: true`. |
| `unverified` | 2 | true | Source acquisition failed; proceed and surface the warnings. |
| `needs_attention` | 2 | true | Local shipped templates used; proceed with a visible warning and no freshness claim. |
| `pending` | 1 | false | Check mode found generated replacements still to apply. |
| `conflict` | 1 | false | Stop; a structural, prerequisite or legacy-marker conflict wrote nothing. |
| `failed` | 1 | false | Stop; publication failed or recovery did not restore the tree. |

Only `synchronized` with `verified: true` means the artifacts are current; warnings proceed visibly without a freshness claim. A blocking `conflict` or `failed` stops ordinary work and reports affected paths. Never rely on the process exit code alone: warnings exit 2.

## Native gate protocol

The `ai-workflow sync-hook` entry has two output shapes:

| Form | Output to follow |
| --- | --- |
| `--phase` on every host; OpenCode stdin gate | Raw gate JSON: top-level `decision` (`allow`, `deny`, `skip`), `project`, `context`, optional `authority`, and `SyncReport` nested under `report` (absent for `skip` or an actor exemption). Read both `decision` and the nested `report` when present. |
| Claude Code and Codex stdin gates | Host-native `systemMessage`; `hookSpecificOutput` with `hookEventName`, `additionalContext`, plus `permissionDecision`/`permissionDecisionReason` on a `PreToolUse` deny. A `UserPromptSubmit` block has top-level `decision: block` with `reason`. These gates never expose raw `allow`/`deny`/`skip`. |

Never run `sync-hook --host <host>` by hand without the host payload on stdin. Every handled form exits 0 even on a deny; follow the host protocol rather than that exit code.

## Enablement

- Codex hooks require human review and trust; there is no trust bypass.
- OpenCode needs a restart to load its plugin; an unloaded plugin is not active.
- A disabled or untrusted hook, or a duplicate host-scoped skill, is not an active automatic updater and must be named rather than silently approved.
- A host crash or timeout that fails open is an enforcement limitation, not a successful block.
