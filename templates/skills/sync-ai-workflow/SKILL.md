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

## Incremental synchronization

Run the installed incremental CLI. It never clones the repository, builds the CLI, or
replaces a target with a whole-file template copy; a complete template overwrite destroys
independent project content and is out of scope:

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

The fixed source is repository `hengboy/ai-workflow`, branch `simplify`. Read `GH_TOKEN`
first and `GITHUB_TOKEN` second as an explicit bearer authorization header; never search
credential files, invoke Git, print tokens, or infer authentication from a GitHub CLI or SSH
configuration.

## Report and decisions

The manual `ai-workflow sync [project]` command prints a `SyncReport` with `status`, `verified`,
`proceed`, `check`, `created`, `updated`, `skipped`, `warnings` and `conflicts`, and no
`decision` field. The native `ai-workflow sync-hook` gate used by installed host entries prints
a different shape: a top-level `decision` of `allow`, `deny` or `skip`, `project`, `context` and
optional `authority`, with the `SyncReport` nested under `report` (absent for `skip` or an actor
exemption). Never run `sync-hook --host <host>` by hand without the host payload on stdin; a
cooperative boundary uses `--phase --project <actual-root>` and the exit code stays 0 even when
`decision` is `deny`, so follow `decision` rather than the exit code.

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
stops ordinary work and reports the affected paths. Parse the JSON `decision`, `proceed` and
`status` rather than the process exit code alone, because a warning also exits 2.

## Enablement

- Codex hooks require a human review and trust step; there is no trust bypass.
- OpenCode needs a restart to load its plugin; an unloaded plugin is not active.
- A disabled or untrusted hook, or a duplicate host-scoped skill, is not an active automatic
  updater and must be named rather than silently approved.
- A host crash or timeout that fails open is an enforcement limitation, not a successful block.

## Completion checklist

- The adoption already existed; this skill initialized no new project, reinstalled no host
  entry and expanded no product scope.
- The incremental CLI ran (or `--check`) with no clone, build or whole-file copy.
- The `SyncReport` was parsed and its `status`, `verified` and `proceed` were reported
  truthfully.
- A freshness claim was made only for a `verified`, `synchronized` result.
- Blocking statuses stopped work and warnings were surfaced.
