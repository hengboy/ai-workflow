---
name: sync-ai-workflow
description: Synchronize an existing ai-workflow adoption's managed workflow instructions from upstream with the incremental CLI. Use for a manual, user-requested synchronization of an already adopted project.
---

# Sync ai-workflow

## Outcome

Bring an existing ai-workflow adoption's managed workflow instructions up to the current
upstream templates without replacing project-owned content. Use this skill only for a
project that already contains `.ai-workflow/`, and only on an explicit user request; first
adoption, installer setup, host reinstallation and a repo-wide upgrade stay with the
setup-ai-workflow skill.

Automatic synchronization is a different, passive path: it runs once at each planning, coding or
plan-to-tasks skill start, stores the complete result for the actual root outside the project,
and serves every native host event afterward from that stored per-root result with no source
request. This skill instead performs its own fresh, cache-independent synchronization on the
user's explicit request, and it never replaces the stored gate decision. Do not start that
automatic check from here.

## Incremental synchronization

Run the installed incremental CLI. It never builds the CLI and never replaces a target with a
whole-file template copy; it acquires the current templates with a shallow temporary clone of
the fixed public address. A complete template overwrite destroys independent project content
and is out of scope:

- `ai-workflow sync [project]` applies safe section patches to the managed files and reports
  the result. An omitted project defaults to the actual current directory and is normalized
  to its adopted root.
- `ai-workflow sync [project] --check` computes the same verdict and proposed patch without
  writing; use it to inspect pending changes before applying them.

The core patches only owned `<!-- ai-workflow:section <id>:begin/end -->` sections, preserves
every byte outside them, adopts an exact unmarked same-heading legacy section, and inserts a
clearly absent section once. It writes no product code, no navigation, no note body, no
frozen plan or task file, and performs no Git operation. Frozen planning artifacts are never
synchronization input.

## Source and credentials

The fixed source is `https://github.com/hengboy/ai-workflow.git`, branch `simplify`.
Acquisition is a shallow temporary clone of that public address; there is no token, credential
file, GitHub CLI or SSH configuration handling, and the clone reads no secret and stores no
credential. Never search credential files, invoke a GitHub CLI, or infer authentication from
SSH configuration.

## Report and decisions

The manual `ai-workflow sync [project]` command prints a `SyncReport` with `status`, `verified`,
`proceed`, `check`, `created`, `updated`, `skipped`, `warnings` and `conflicts`, and no
`decision` field. The native `ai-workflow sync-hook` entry has two output shapes. The `--phase`
form on every host, and the OpenCode stdin gate, print the raw gate JSON: a top-level `decision`
of `allow`, `deny` or `skip`, `project`, `context`, optional `authority`, and the `SyncReport`
nested under `report` (absent for `skip` or an actor exemption). The Claude Code and Codex stdin
gates instead emit host-native output (`systemMessage`; `hookSpecificOutput` with
`hookEventName`, `additionalContext` and `permissionDecision`/`permissionDecisionReason` on a
`PreToolUse` deny, while a `UserPromptSubmit` block carries a top-level `decision` of `block`
with `reason`) and never expose the raw `allow`/`deny`/`skip` decision. Never run `sync-hook --host <host>` by hand without the host payload on stdin; every
handled form exits 0 even on a deny, so the host follows its protocol rather than the exit code,
and the planning, coding and plan-to-tasks skills use the `--phase --project <actual-root>` form once when their skill session starts.

| Status | Exit | Proceed | Action |
| --- | --- | --- | --- |
| `synchronized` | 0 | true | Success; a freshness claim is allowed. |
| `unverified` | 2 | true | Source acquisition failed; proceed and surface the warnings. |
| `needs_attention` | 2 | true | Safe patches applied or retained; ambiguous content remains. |
| `pending` | 1 | false | Check mode found safe changes still to apply. |
| `conflict` | 1 | false | Stop; a structural conflict wrote nothing. |
| `failed` | 1 | false | Stop; publication failed or recovery did not restore the tree. |

Only a `synchronized` result with `verified: true` means the managed artifacts are current; a
warning result proceeds but makes no freshness claim. A blocking `conflict` or `failed` status
stops ordinary work and reports the affected paths. Read a raw gate's top-level `decision` and
its nested `report`, and read a manual `SyncReport` by `status`, `verified` and `proceed`; never
rely on the process exit code alone, because a warning also exits 2.

## Enablement

- Codex hooks require a human review and trust step; there is no trust bypass.
- OpenCode needs a restart to load its plugin; an unloaded plugin is not active.
- A disabled or untrusted hook, or a duplicate host-scoped skill, is not an active automatic
  updater and must be named rather than silently approved.
- A host crash or timeout that fails open is an enforcement limitation, not a successful block.

## Completion checklist

- The adoption already existed; this skill initialized no new project, reinstalled no host
  entry and expanded no product scope.
- The incremental CLI ran (or `--check`) with no CLI build and no whole-file copy; template
  acquisition used only the shallow temporary clone.
- The `SyncReport` was parsed and its `status`, `verified` and `proceed` were reported
  truthfully.
- A freshness claim was made only for a `verified`, `synchronized` result.
- Blocking statuses stopped work and warnings were surfaced.
