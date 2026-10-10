# Agent Note: Generated local project instructions

Status: implemented

English | [中文](2026-10-10-generated-local-instructions.zh.md)

## Problem

Project instructions were owned section by section: `ai-workflow sync` and `ai-workflow init --upgrade` patched six marked `templates/project` Markdown files through `<!-- ai-workflow:section <id>:begin -->` / `<!-- ai-workflow:section <id>:end -->` markers, and root `MEMORY.md` was one of them. The scheme kept a shared generic workflow memory inside `MEMORY.md`, forced every generated file to carry ownership markers, and treated a differing unmarked section as ambiguous `needs_attention` content. It also left an unsafe cutover: an old CLI with an old marked upstream could restore markers or rewrite local memory in a project that had already been converted.

## Decision

- Exactly five markerless generated files are owned by the fixed allowlist in `src/sync/artifacts.ts` (`generatedArtifacts`): `templates/project/AGENTS.md` to `.ai-workflow/AGENTS.md`, `templates/project/notes/AGENTS.md` to `.ai-workflow/notes/AGENTS.md`, `templates/project/notes/README.md` to `.ai-workflow/notes/README.md`, `templates/project/notes/implemented/AGENTS.md` to `.ai-workflow/notes/implemented/AGENTS.md` and `templates/project/notes/archived/AGENTS.md` to `.ai-workflow/notes/archived/AGENTS.md`.
- Synchronization and shipped-template upgrade compare and replace each generated target as a complete file, create an absent one and skip an identical one; a manual edit inside a markerless generated file is overwritten by design. `src/sync/merge.ts` and its `mergeOwnedSections`, `validateOwnedSections` and `OwnershipConflictError` are removed, and no section parser, same-heading adoption or migration remains.
- Root `MEMORY.md` is project-owned and init-only: a fresh `init` writes a minimal local skeleton only when the file is missing, and sync and upgrade never replace, append, normalize, compare against a template or migrate it. `templates/project/MEMORY.md` is only that init-time bootstrap scaffolding, and its unique generic execution, TDD, session-handoff and host-native role facts moved into `templates/project/AGENTS.md`.
- Source validation requires a complete five-member snapshot of nonempty Markdown with a level-one title and no legacy `ai-workflow:section` markers. A missing or malformed member reports `unverified` with `verified: false`, `proceed: true` and zero target writes, and a target that still carries legacy markers is refused as `conflict` with its path and a manual-replacement instruction before any write.
- Shared artifact validation lives in `src/sync/artifacts.ts` (`generatedDocumentError`, `validateGeneratedSnapshot`, `hasLegacySectionMarker`), and `src/sync/index.ts` (`applyTemplateSnapshot`, `synchronizeProject`, `reconcileIgnoreFile`, `notesStructureDirectories`) is the publication core that `upgradeProject` reuses with the shipped local templates and a null source commit.
- The cutover order is to refresh the managed CLI and host entry commands, retain project content in `MEMORY.md`, replace the generated files manually, validate with the new CLI, and only then start another workflow skill; publishing the markerless templates upstream is a user-owned external action.
- Three combinations stay distinct: a new CLI with old-format upstream is `unverified` with no writes, an old CLI with new markerless upstream fails its own source validation, and an old CLI with old marked upstream against new markerless targets can restore markers or rewrite `MEMORY.md` and is never claimed zero-write safe. If that window runs, inspect the disclosed paths, preserve project facts, refresh the CLI and entries, restore `MEMORY.md` and re-replace the generated files.

## Alternatives considered

- Keep section-level ownership markers for the generated files. Declined because complete-file ownership is simpler, matches a markerless upstream, and removes the baseline and same-heading ambiguity the marker scheme still carried.
- Keep root `MEMORY.md` as a synchronized file. Declined because it mixes project architecture and standards with generated generic workflow instructions and makes local editing unsafe; it is now init-only and local.
- Migrate still-marked projects automatically. Declined because the old format cannot distinguish generated content from project content, so migration would rewrite local data; conversion is a manual operator step.
- Add an `AGENTS.local.md`, a `.ai-workflow/MEMORY.md`, a generated digest manifest or a stored baseline. Declined because the fixed five-file allowlist and init-only local memory need no extra file and no stored history.

## Consequences

- The project instructions for every host are exactly the five generated files plus local `MEMORY.md`; the contract owns the generic execution, TDD, session-handoff and host-native role rules that `MEMORY.md` no longer duplicates.
- A manual edit inside a generated file is replaced on the next synchronization by design, so project additions belong in `MEMORY.md` or the notes.
- Legacy marked projects are converted manually, and the old-CLI/old-upstream/new-target window needs explicit operator ordering and recovery because the old binary cannot validate the new format.
- Semantic correctness still depends on review: mechanical validation checks presence, markerless structure, paths, statuses and report shapes, not whether a generated file is truthful.
- The [Project template synchronization](../feature/2026-10-08-project-template-sync.md), [Project contract and Agent Notes replacement](../process/2026-09-16-project-contract-and-agent-notes.md), [Synchronize once at skill start](../feature/2026-10-09-sync-once-at-skill-start.md) and [Public git template source](../simplification/2026-10-09-public-git-template-source.md) records are partially superseded: their cadence, gate, retrieval and governance rationale stays current, while their marked six-file, section-merge and marker-structure facts are replaced by complete-file ownership of five markerless files.
