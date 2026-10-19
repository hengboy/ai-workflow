# Agent Note: MEMORY is current-state only

Status: implemented

English | [中文](2026-10-19-memory-governance.zh.md)

## Problem

`MEMORY.md` had drifted into a change log: statements such as "was removed", "no longer" and "previously" described superseded states instead of the standard the project follows today. `MEMORY.md` is read as fixed context at the start of every session, so a historical or stale statement is read as the current rule, and a reader cannot distinguish the standard in force from the history that produced it. Git and Agent Notes already preserve why a standard changed; the durable memory file had no equivalent discipline for keeping its own statements current.

## Decision

- **Current-state only.** `MEMORY.md` records only the project's current standards and behavior. The change that supersedes a statement rewrites it to the current state or removes it in the same change, so the recorded standards stay current as changes land.
- **History lives elsewhere.** Superseded history belongs to Git and Agent Notes, never to `MEMORY.md`. An absence statement about a mechanism that does not exist, such as "there is no `update` subcommand", remains a legal current fact, while a narrative delta such as "are removed" or "was removed" does not.
- **Same-change obligation.** The change that lands a replacement owns the rewrite of the statement it supersedes, and the Documentation Maintainer carries this as a hard gate so `MEMORY.md` and the notes stay consistent in one change.
- **Shipped surfaces.** The rule ships through the project contract's `## Shared context and maintenance` section, the `documentation-maintainer` role procedure, the init bootstrap `templates/project/MEMORY.md`, and the `### MEMORY maintenance` section of `README.md`, so adopted projects receive it through the existing synchronization path.
- **Root memory brought current.** This repository's own `MEMORY.md` is rewritten so every retained statement describes the current project state, with the historical phrasing replaced by the current standard.

## Alternatives considered

- **Automated staleness checker.** Declined: no mechanical check can decide whether prose still matches current behavior, so a scanner would either flag correct current-state facts or miss real drift, and it would add a new command and schema surface beyond documentation.
- **Changelog-style `MEMORY.md`.** Declined: keeping history as appended entries turns a fixed-context document into a growing log that mixes current standards with superseded ones, which is exactly the Git and Agent Notes role.
- **Leave the staleness in place.** Declined: readers would keep mistaking historical phrasing for the current standard, and no same-change obligation would keep the file current.

## Consequences

- `MEMORY.md` reads as a current-state-only document every session, so a reader sees the standards in force without filtering out superseded history.
- The rule ships through the contract, role, init bootstrap and `README.md`, so adopted projects receive it with no migration whenever synchronization refreshes those files.
- Superseded history stays retrievable from Git and Agent Notes, so the rationale and the prior state are not lost when a statement is rewritten.
- Keeping `MEMORY.md` and the notes consistent in one change becomes a reviewable obligation on the Documentation Maintainer rather than an implicit expectation.
- A behavior regression test asserts the rule on every shipped surface and the absence of the banned history phrases in root `MEMORY.md`.
