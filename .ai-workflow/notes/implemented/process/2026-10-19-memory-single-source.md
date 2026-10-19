# Agent Note: MEMORY single-sources the workflow contract

Status: implemented

English | [中文](2026-10-19-memory-single-source.zh.md)

## Problem

Root `MEMORY.md` had grown to restate the project's workflow contract, so the same rule existed in two places at once. A reader of the fixed context could not tell which copy was authoritative, and a change that updated one copy left the other describing an older rule. The project contract in `.ai-workflow/AGENTS.md` and the note governance in `.ai-workflow/notes/README.md` already own the generic workflow rules, so the restatements added maintenance cost and drift risk without adding a distinct standard.

## Decision

- **One authoritative home per workflow rule.** Root `MEMORY.md` records only the project's current product, repository and meta standards and behavior. Every workflow rule is delegated to its single owner: the project contract in `.ai-workflow/AGENTS.md` and the note governance in `.ai-workflow/notes/README.md`.
- **Exactly one pointer standard.** `MEMORY.md` carries one workflow-authority pointer that names both `.ai-workflow/AGENTS.md` and `.ai-workflow/notes/README.md` and states that the workflow contract lives there rather than being restated in `MEMORY.md`.
- **Retained project standards.** Product and repository facts, the shipped-surface facts and the two meta standards stay in `MEMORY.md`, because they describe this project rather than the generic workflow contract.
- **Related current-state rule.** This decision builds on the current-state-only discipline recorded in the [memory-governance record](2026-10-19-memory-governance.md); that record owns how `MEMORY.md` stays current, while this record owns where each rule lives.

## Alternatives considered

- **Keep the restatements.** Declined: duplicated workflow rules drift, and a reader of the fixed context cannot distinguish the authoritative copy from a stale one.
- **Move every standard into the contract.** Declined: the retained product and repository facts are project-owned, and shipping them through the generated contract mirror would carry project-specific facts into the adopter template.
- **Merge this decision into the memory-governance record.** Declined: the governance record owns the currency rule, while the delegation boundary is a separate decision, so it is recorded as a new note linked to the prior one.

## Consequences

- Every workflow rule has exactly one authoritative home, so a change updates one surface instead of keeping `MEMORY.md` and the contract in step by hand.
- `MEMORY.md` reads as the project's current standards document and stays shorter, while the contract and the note governance keep owning the workflow rules they already describe.
- After this change merges, `main` must be pushed to `origin` before the next planning, coding or plan-to-tasks skill start in this repository: the synchronization preflight replaces `.ai-workflow/AGENTS.md` from the upstream snapshot and would otherwise revert the corrected mirror.
- A behavior test asserts the single pointer, the retained facts and the absence of the delegated workflow topics in root `MEMORY.md`.
