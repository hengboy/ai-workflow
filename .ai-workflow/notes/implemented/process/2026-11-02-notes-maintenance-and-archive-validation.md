# Agent Note: Notes maintenance and archive baseline validation

Status: implemented

English | [中文](2026-11-02-notes-maintenance-and-archive-validation.zh.md)

## Problem

Notes governance had gaps that let a maintenance change remove or rewrite history while still passing structural validation. Supersession assessment existed, but it did not require the change landing a decision to dispose each identified match, so a superseded record could remain reachable as current guidance. The complete-removal condition was stated too briefly to require evidence that production code, configuration, schemas, durable or wire data, migration and compatibility no longer support the capability. Archive validation still applied the active-body rules, so an archived record that preserves an older title, header or section layout could be rejected even though sealed history must never be rewritten into the current format. The archive checks also had no Git-based guarantee that a later change preserved the paths and digests sealed earlier, because a self-consistent filesystem manifest and its archived bytes could be rewritten together. The regular project check did not run note validation directly, so sealed-history drift stayed outside it.

## Decision

- Keep the active body format, language switcher and structure mirror as rules for active notes only. An archived record preserves its historical title, blank lines, switcher, sections and both sides' old structure; archive integrity checks only the complete triplet, legal path, `Status: implemented` with an immediately following bilingual archive date not earlier than the file-name date, the recorded pair hashes and the manifest entries.
- Treat same-change supersession as part of landing a decision, not as an optional later cleanup, because a deferred disposition leaves a superseded record reachable as current guidance and the later pass may never happen. A related record with independently useful rationale that the new note does not supersede stays active; only an identified full supersession is consolidated, and a partial supersession stays active with a cross-link.
- Require complete removal as evidence when an earlier feature-addition record is consolidated into a later removal record and deleted: production code, configuration, schemas, durable or wire data, migration and compatibility no longer support the capability, and documentation and tests no longer claim support, while residual compatibility or data keeps the earlier record as a partial supersession.
- Make `--base <commit>` an immutable Git comparison rather than a second filesystem check. The command resolves the ref to one commit, reads the archive manifest through the project-relative repository path so a project root, a repository subdirectory and a linked worktree agree, treats a commit without the manifest as a legitimately empty baseline, and fails an unknown, unreadable or malformed baseline before any write. Every archived path and digest recorded at that commit must remain present and unchanged; a later seal may append new entries but never drop or rewrite an old one.
- Wire the same check into the project check as `tsx src/cli.ts notes validate --project . --base HEAD`, where the local check uses HEAD as its pre-change baseline and a committed range or CI supplies its explicit base. This keeps the default filesystem-only command usable without Git while making sealed-history drift visible in the normal check.

## Alternatives considered

- Applying the active format and structure mirror to archived records. Declined because sealed history would then have to be rewritten whenever active formatting changes, which contradicts the byte freeze and destroys the historical record.
- Treating every related note as a mandatory archive. Declined because a related record can still carry independently useful alternatives, ownership or guarantees after a new decision lands, and archiving it would remove reachable current guidance.
- Allowing the earlier feature-addition record to be deleted whenever a removal note exists. Declined because a capability may remain in compatibility paths, durable data or documentation, and deleting the earlier record would then hide reintroduction conditions and the original motivation.
- Comparing only the current filesystem manifest. Declined because a change could rewrite an archived file and its manifest together and still appear internally consistent; the Git baseline makes the pre-change seal the authority.
- Requiring `--base` on every notes command. Declined because a new notes tree and ordinary local authoring must remain usable without Git history, while the base gate is a delivery check rather than a general authoring requirement.

## Consequences

- Active notes keep one mirrored bilingual format, while archived notes remain readable as sealed historical records without active-format revalidation; the archive manifest stays append-only for existing entries.
- The 2026-10-16 [note rationale and retention record](./2026-10-16-note-rationale-and-retention.md) is partially superseded: its creation criterion and keep, archive and delete outcomes remain current, while this record adds same-change supersession dispositions and explicit complete-removal evidence for feature-addition consolidation.
- The archive section of the 2026-09-16 [project contract and Agent Notes record](./2026-09-16-project-contract-and-agent-notes.md) is partially refined: the sealing mechanism and byte freeze stand, and this record adds the Git baseline and the explicit archived-format exception.
- The 2026-10-19 [archive retention assessment](./2026-10-19-archive-retention.md) remains valid and unchanged; it decides which records to archive, while this record decides how archive integrity is enforced.
- `src/notes/archive-baseline.ts` owns commit resolution, project-relative path lookup and manifest comparison; `validateNotes` and `sealArchive` both consume it, and `package.json` runs the base check in `check`.
- The trade-off is that a local check using `HEAD` proves only the committed pre-change state, not a future commit, and an unreadable repository or baseline now fails the check rather than silently falling back to filesystem consistency.
