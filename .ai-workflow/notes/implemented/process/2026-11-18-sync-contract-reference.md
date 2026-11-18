# Agent Note: Compact contract reference for the synchronization gate

Status: implemented

English | [中文](2026-11-18-sync-contract-reference.zh.md)

## Problem

The stored phase-entry result carried the full project contract text in an `authority` field so that native session, prompt and tool events could replay it. That made every stored unit and every replayed notice as large as the contract itself, and it duplicated a document every role is already required to read explicitly. Keeping the field name with a different value shape was also unsafe: an older installed plugin compares `authority` as a string, so an object value would deny ordinary tools forever.

## Decision

- `src/sync/gate.ts` exposes a compact `ProjectGateAuthorityRef` with an absolute `path`, a `sha256:` `digest` and a byte count. The phase result and the stored unit carry the `decision`, the nested `report`, a short `context` and an optional `authority_ref`; the contract body is never stored or replayed. The result context names `Project contract: <path>` together with the instruction to read that path before ordinary work continues.
- Stored units are version 2. A version 1 unit, or a unit that still carries a legacy `authority` field, is not a current check: readers allow with a visible no-check context, make zero source requests, write nothing, and the next phase entry writes a version 2 unit.
- A reference exists only when that run created or updated a managed authority file; a no-update phase stores a reference-free result.
- The OpenCode v1 (`templates/hooks/opencode.js`) and v2 (`templates/hooks/opencode-v2.js`) plugins inject a given decision-plus-context notice at most once per session, clear notice state only on session lifecycle events, and gate ordinary tools on a completed read of the exact contract whose SHA-256 matches the reference. Injecting the notice is not a read, later user turns do not invalidate a completed read, child sessions read independently, and an out-of-band contract edit never satisfies the stored reference.
- The raw gate JSON form and the Claude Code and Codex host-native output shapes stay unchanged, as do the manual `ai-workflow sync` command and `SyncReport` semantics.
- Published guidance states that the path-and-digest notice is not a complete contract injection and that every role explicitly reads the project contract; the contract template and its mirror, the OpenCode plugin templates and `MEMORY.md` carry that statement.

## Alternatives considered

- Keeping the full contract as an extra one-time phase-entry field. Declined because it stores a second full copy of a document every role reads explicitly and keeps replaying it.
- Sanitizing version 1 units at read time. Declined because it adds a compatibility layer over stale full contract text that the next phase entry replaces anyway.
- Keeping the `authority` field name with an object value. Declined because an old installed plugin compares that field as a string and would deny ordinary tools forever.

## Consequences

- Native replays stay short and the stored unit holds no contract bytes.
- The OpenCode plugins block ordinary tools until the contract is read, and an edited contract invalidates the stored digest until the next phase entry stores a fresh reference.
- A version 1 unit stays invalidated until the next phase entry replaces it.
- Rolling back to the previous CLI treats a version 2 unit as no check until the next phase entry rewrites it.
- This record partially supersedes [Synchronize once at skill start](../feature/2026-10-09-sync-once-at-skill-start.md): its cadence, exemptions, cache-only native events and stored-deny behavior stay current, while its full-text `authority` payload is replaced by the compact digest reference.
- This record does not supersede [Project template synchronization](../feature/2026-10-08-project-template-sync.md), [Generated local project instructions](../simplification/2026-10-10-generated-local-instructions.md) or [Workflow semantics, durable state progression and role-scoped context](./2026-11-02-workflow-semantics-context.md); their retrieval, report, five-file ownership and role-scoped context decisions stay current.
