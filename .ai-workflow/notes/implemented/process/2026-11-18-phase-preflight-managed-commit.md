# Agent Note: Phase-start managed maintenance commit

Status: implemented

English | [中文](2026-11-18-phase-preflight-managed-commit.zh.md)

## Problem

Automatic phase-start synchronization replaces managed workflow instruction files when upstream changes them, but the phase session previously continued with those changes uncommitted. A phase then began from a dirty managed baseline, and a later worktree checkout or ordinary commit could carry an unrelated pending modification. The synchronization core, hook, gate and manual command intentionally perform no Git, the hook cannot dispatch a sub-agent or obtain commit authority, and a manual synchronization is a separate explicit user action, so no synchronization component could record the refreshed files.

## Decision

- A proceeding phase result from `ai-workflow sync-hook --host <current-host> --phase --project <actual-root>` with a non-empty `created` or `updated` set makes the same planning, coding or plan-to-tasks session delegate one scoped local maintenance commit of exactly those reported managed paths to Git Operator before ordinary work. The session re-reads an updated contract before continuing.
- Git Operator stages and commits only the reported managed paths on the current branch and preserves every unrelated staged, unstaged and untracked change. Planning artifacts, task files and product edits are never included, and a created empty directory is not a tracked path.
- A `skip`, an empty `created` and `updated` set, or a non-proceeding `deny`, `conflict` or `failed` gate result produces no commit, no empty commit and no Git dispatch.
- A blocked or failed maintenance commit stops the phase with a bounded support request, and ordinary project work does not continue.
- The maintenance commit is not an implementation commit, a reviewed range or an integration authorization. Its position in delivery history follows the phase session that made it, and it supplies no review range.
- The synchronization core (`src/sync/index.ts`, `src/sync/artifacts.ts`, `src/sync/source.ts`), the gate (`src/sync/gate.ts`), the hook and plugin entries, and the manual `ai-workflow sync` command remain no-Git and perform no staging. The hook only receives a phase result and cannot dispatch a sub-agent, obtain review authority or hold a bounded write scope, while manual synchronization is a separate explicit user action whose session has no phase authority; the phase session owns the bounded Git Operator dispatch, which is that session's only synchronization-related Git operation.
- The rule is published in the project contract and its byte-identical mirror, the planning, coding and plan-to-tasks skills, `README.md`, `MEMORY.md` and this record.

## Alternatives considered

- Making the CLI or hook perform the commit. Declined because the hook runs at a host boundary, cannot dispatch a sub-agent or obtain review authority, and moving Git into the synchronization core would give a file-replacement path commit authority and break the no-Git boundary.
- Leaving refreshed managed files uncommitted. Declined because a phase would start from a dirty managed baseline, and a later worktree checkout or ordinary commit could absorb or conflict with an unrelated pending modification.
- Committing every dirty file at phase start. Declined because it would stage unrelated work, planning artifacts, task files and product edits, discard the operator's pending changes and turn an instruction refresh into an uncontrolled commit.
- Committing only in implementation sessions. Declined because planning and plan-to-tasks also run the phase check and receive managed updates, so those sessions would keep the same dirty baseline and could mix planning artifacts with managed changes.
- Committing from the manual synchronization skill. Declined because manual synchronization is a separate explicit user action with no phase scope or review authority, and the automatic phase path is the only place the reported managed paths are known.

## Consequences

- A phase begins from a clean managed baseline, and the refresh is recorded as one small, reviewable maintenance commit.
- The commit contains only the reported managed paths, so unrelated staged, unstaged and untracked changes stay available for their own work.
- A `skip`, an empty change set or a non-proceeding result produces no commit and no empty commit, and a blocked or failed commit stops the phase with a bounded support request.
- The synchronization core, hook, gate and manual command stay Git-free, and the maintenance commit is not an implementation commit, reviewed range or integration authorization.
- This record does not supersede [Project template synchronization](../feature/2026-10-08-project-template-sync.md), [Synchronize once at skill start](../feature/2026-10-09-sync-once-at-skill-start.md) or [Compact contract reference for the synchronization gate](./2026-11-18-sync-contract-reference.md): their file replacement, single-start cadence, compact authority reference and synchronization-time no-Git decisions remain current.
