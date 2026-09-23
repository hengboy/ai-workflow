# Agent Note: Migrate retired ADR records to notes

Status: implemented

English | [中文](2026-09-17-migrate-retired-adr-records-to-notes.zh.md)

## Problem

The 2026-09-16 [project contract and Agent Notes replacement record](./2026-09-16-project-contract-and-agent-notes.md) established Agent Notes as the only proposal and decision mechanism and, per that plan's Non-goals, preserved the five 2026-09-14 records under `.ai-workflow/adr/` as local historical bytes: the product no longer read, listed or validated them. As a result, the problem context, declined alternatives and costs in those records could only be reviewed by reading files by hand, could not be found through `ai-workflow notes list`, and could not be linked to the current mechanism. The mechanisms described by 0002, 0003 and 0005 had already been superseded by notes and the project contract, while 0001 and 0004 were still current authority. If historical rationale is not searchable, later maintainers repeat trade-offs that were already evaluated and declined, and cannot tell which old conclusions still hold.

## Decision

- Migrate the five records into implemented notes in a one-time manual pass: 0001 and 0004 as authority records that are still current and used by the current mechanism; 0002, 0003 and 0005 as delivered records whose mechanism was later superseded, with the supersession stated in the body and a cross-link to [the project contract and Agent Notes replacement record](./2026-09-16-project-contract-and-agent-notes.md).
- The migration faithfully preserves each record's real problem, decision, actually considered alternatives with their rejection reasons and costs, following the implemented-note structure; it backfills no unrecorded alternatives, copies no reference-project content and keeps no unimplemented planning sections.
- After the migration succeeds and `ai-workflow notes validate` passes, delete the five files under `.ai-workflow/adr/` and the empty directory.
- This was a one-time manual action against this repository's existing data only. Product behavior is unchanged: there is still no `adr` command, alias, conversion entry, dual write or fallback; any residual historical file is still not read, listed or validated. The user explicitly authorized this deviation from the Non-goals of frozen plan `20260916-project-contract-and-agent-notes` ("do not automatically delete the user's existing local ADR history files"); that authorization was limited to this migration, changed no publishable behavior and restored no compatibility path.

## Alternatives considered

- **Keep the ADR files without migrating.** Considered for zero risk and intact original bytes; declined because the product no longer reads them, so the retrieval cost and the "historical rationale disconnected from the current mechanism" problem would remain, and no cross-links could be established.
- **Migrate only the still-current 0001 and 0004.** Declined because the alternatives and costs recorded in 0002, 0003 and 0005 explain where the current notes and project contract came from, and migrating only two would leave an unsearchable historical gap.
- **Migrate and also keep the original ADR files.** Declined because the same decision would then exist in two records of different formats, making it hard for readers to tell which is current authority; keeping copies would also require annotating each supersession, costing more maintenance than the retention is worth.
- **A productized conversion command (for example `ai-workflow notes import-adr`).** Declined because the product fully removed the ADR mechanism and explicitly has no compatibility path, and adding a new public command for one-time local data would reintroduce supported surface, help text and test burden.

## Consequences

- The five historical records' rationale, declined alternatives and costs are now searchable through the notes directory and `ai-workflow notes list`: [project-local worktree policy](./2026-09-14-project-local-worktree-policy.md) and [share ignored state into the worktree](./2026-09-14-share-ignored-state-into-worktree.md) are current authority; [derive the ADR list on read](../simplification/2026-09-14-derive-adr-list-on-read.md), [localize ADR prose at install time](./2026-09-14-localize-adr-prose-at-install-time.md) and [move the agent contract into user-level global instruction files](../architecture/2026-09-14-user-level-agent-contract.md) state that their mechanism was superseded.
- Deletion is irreversible: the original `.ai-workflow/adr/*.md` files were gitignored, untracked local data covered by `.ai-workflow/`, with no repository copy, backup or hash manifest; after deletion the historical bytes exist only in the migrated note bodies, which were rewritten to the notes format and current facts and no longer match the originals byte for byte.
- The product and supported workflow are unchanged: there is still no `adr` command, alias, conversion or fallback, and residual historical files are still not read, listed or validated; this migration is not a supported entry point.
- 0002, 0003 and 0005 were not archived or marked rejected: they describe delivered mechanisms that were later superseded, not declined proposals, so they do not enter `rejected`; no archive was performed either, because archiving needs a separate `ai-workflow notes archive --seal` step and semantic review, and archived records by default no longer appear in `notes list`, which would reduce these three records' reachability as explanation sources. Whether to archive them is left to a later change when needed.
