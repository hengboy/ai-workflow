# Agent Note: Note creation requires lasting decision rationale and defines retention

Status: implemented

English | [中文](2026-10-16-note-rationale-and-retention.zh.md)

## Problem

The notes README required a note for every non-mechanical change, and the five workflow consumers repeated that universal obligation. The rule duplicated records for behavior and architecture changes whose rationale is already recoverable from code, tests and current documentation, while the README defined no criterion for retiring, archiving or deleting an active implemented record. Authors had to decide by habit whether a small mechanical note could be dropped and whether a retained historical record could be removed, so the corpus could grow without guiding value or lose decisions that still mattered.

## Decision

- Note creation is governed by lasting decision rationale that code, tests and existing documentation cannot adequately explain. Behavior changes, file counts and added tests are insufficient on their own, and local, mechanical, UI, copy and formatting changes without such lasting rationale are exempt.
- Reuse the existing note that owns the same decision and keep its shipped facts current in the same change; record a changed decision or lasting rationale as a new linked note.
- Retention follows future-guidance value: keep an implemented record while its alternatives, ownership, important guarantees, data semantics or reintroduction conditions still guide future work; archive a completed implemented decision with little future guidance but historical decision value; delete only an active implemented triplet limited to small UI adjustments or purely mechanical changes without lasting decision value, and never a small bug fix, performance change, new capability or substantive behavior decision; retain a rejected record only while it prevents a plausible, meaningful mistake.
- An authorized deletion removes the complete triplet and repairs inbound links, existing supersession preservation and the frozen-archive prohibitions keep applying, and no cleanup authority is granted by this record.
- The five consumers, the planning, plan-to-tasks and coding skills, the documentation-maintainer role and the standards-review role, and their completion checks defer to the README criterion instead of independently requiring a note for every non-mechanical change.
- The policy is delivered through the existing five-file template snapshot and its synchronization, with no runtime, schema, CLI or persistent-format change.

## Alternatives considered

- Keeping the universal non-mechanical trigger. Declined because it duplicates records for changes that code, tests and existing documentation already explain, adding review and maintenance cost without new guidance.
- Copying the reference project's whole note-retention policy. Declined because its remaining clauses answer problems this project does not have, which would import rules, artifacts and validation surface with no current need.

## Consequences

- The README remains the single governance source and now carries both the creation criterion and the retention outcomes; the five consumers point to it instead of restating an unconditional trigger.
- The 2026-09-16 [project contract and Agent Notes record](./2026-09-16-project-contract-and-agent-notes.md) is partially refined: its project-contract and notes-mechanism decision stands, while the creation obligation and retention boundaries now live in the README this record describes.
- Existing decisions still require factual upkeep: a renamed path, symbol or default is corrected in place, and only a changed recorded decision or its lasting rationale creates a new note.
- The delivery is structural only: the shipped-content checks and `ai-workflow notes validate` prove format, structure, pairing and links, but cannot prove that a recorded rationale is truthful or sufficient, which semantic review establishes separately.
