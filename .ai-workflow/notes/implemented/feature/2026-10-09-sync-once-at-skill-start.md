# Agent Note: Synchronize once at skill start

Status: implemented

English | [中文](2026-10-09-sync-once-at-skill-start.zh.md)

## Problem

Automatic synchronization previously re-ran at host boundaries — session start, user turn, resume and actual-root change — and every native event without a reusable unit called the synchronization core, so an upstream 403 rate limit produced repeated source requests within one skill session.

## Decision

- `PhaseEntry` (`ai-workflow sync-hook --host <host> --phase --project <actual-root>`) is the only automatic trigger: each planning, coding or plan-to-tasks skill start runs exactly one fresh synchronization for the operation's actual adopted root and atomically stores the complete result, keyed by that root, in the existing host runtime cache outside the project. No project-local metadata, manifest, version stamp or migration is created.
- Native `SessionStart`, `UserPromptSubmit` and `PreToolUse` events never call the synchronization core: they return the stored result verbatim (decision, project, context, report, authority) with zero source requests. A missing, corrupt or unreadable entry yields an `allow` with a visible no-check context, no freshness claim and no write.
- Session, turn, resume and root-change events no longer invalidate the stored entry; the next skill start atomically replaces it. Sessions and child agents that resolve to the same actual root share it, while a coding worktree with its own `.ai-workflow/` is a distinct actual root and never replays the project-root decision.
- Unadopted directories return `skip` with no source request and no runtime write; the exact synchronization-actor and contract-read exemptions keep their `allow` result without clearing a stored blocker; the stored authority payload keeps enforcing the contract re-read; and `conflict` or `failed` stored decisions keep denying ordinary tools until the next skill start replaces them.
- `src/sync/gate.ts` owns the new `runProjectGate` behavior and `src/cli.ts` `sync-hook` stopped passing the removed resume `eventSource` field. The three skills invoke the phase entry once at skill start, the manual `sync-ai-workflow` skill documents the cadence without gaining a trigger, and the project contract, its template and mirror, README and both MEMORY files describe the single-start cadence and cache-only native events.
- Manual `ai-workflow sync [project]` remains a fresh, cache-independent check that never replaces the stored gate decision, and host installation, uninstallation and every host output shape stay unchanged.
- Targeted verification delivered: `tests/unit/project-sync-gate.test.ts` 15 passed; `tests/integration/project-sync-hooks.test.ts` and `tests/integration/project-sync-cli.test.ts` 21 passed; `tests/behavior/project-sync-content.test.ts` and `tests/integration/global-agent-guidance.test.ts` 6 passed.

## Alternatives considered

- A time-based throttle or configurable interval. Declined because no new configuration surface was approved and cadence, not retrieval, is the problem.
- Removing or weakening the installed host hooks or plugin. Declined because installation additivity and output shapes stay.
- Adding session-start, user-turn or resume triggers. Declined because they recreate the repeated-source-request failure under rate limiting.
- Sharing one cache across different actual roots. Declined because a worktree must not replay the project-root decision.
- Persisting a project-local synchronization record or version stamp. Declined because the cache stays transient host runtime state outside the project and no migration is needed.
- Retrying the source automatically after a warning. Declined because one attempt per check and repeated context replay is expected, with no retry loop.

## Consequences

- At most one source attempt happens per skill start per host and actual root.
- A stored warning replays its context without a second source request.
- A stored deny persists until the next skill start replaces it.
- Users who edit the contract after a stored authority keep the stored requirement until the next skill start.
- Manual sync repairs files but does not replace the stored decision.
- Stale session files from the previous format are unused.
- This record partially supersedes the per-boundary cadence facts of [Project template synchronization](2026-10-08-project-template-sync.md) — its gate-lifecycle Decision bullet and the skills' per-step and per-phase bullet — while that record's retrieval, merge and report contracts stay current.
