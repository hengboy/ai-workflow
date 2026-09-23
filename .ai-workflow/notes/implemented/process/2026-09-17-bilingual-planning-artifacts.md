# Agent Note: Bilingual planning artifacts with a consistency record

Status: implemented

English | [中文](2026-09-17-bilingual-planning-artifacts.zh.md)

## Problem

Frozen `spec.md`, `plan.md` and `tasks/*.md` documents were single-language: the planning skills wrote their prose in the configured `output_language`, and a document had no counterpart, no drift detection and no recorded state of when its two language sides last agreed. The [bilingual note triplets record](./2026-09-17-bilingual-note-triplets.md) had already given Agent Notes a triplet contract, but its Decision still stated that the preference governed generated planning artifacts, so planning artifacts remained the one localized artifact family. Aligning the two artifact families under one contract changed that single claim, while the note-triplet contract itself remains in force, so this decision is recorded as a new note that cross-links the earlier record instead of rewriting it.

## Decision

- Planning artifacts use the same bilingual triplet contract as Agent Notes: `spec.md` plus `spec.zh.md` and `spec.i18n.yaml`, `plan.md` plus `plan.zh.md` and `plan.i18n.yaml`, and `tasks/task-NNN-slug.md` plus its `.zh.md` and `.i18n.yaml`.
- The English side alone carries the YAML frontmatter, the `REQ-###`/`AC-###` identifiers, the counts and the content `digest`; digest semantics are unchanged. The Chinese side has no frontmatter, starts with the same English title and then the Chinese switcher, which carries the `English` label and links to the English document; the English side carries the `中文` label and links to the Chinese document. Both sides mirror each other's heading, code, table, list and link structure, and only prose is translated.
- `ai-workflow plan pairing --plan <directory>` verifies and records the pairs. With no flags it is a read-only check that returns `{ "valid": true, "errors": [] }`, exits nonzero on failure and writes nothing; `--list` reports `missing`, `out-of-sync` or `ok` per document and always exits 0; `--write` accepts `<doc>.md`, `<doc>.zh.md`, `<doc>.i18n.yaml` or a bare `spec`, `plan` or `task-NNN-slug` slug, pre-checks every explicitly selected document and writes no record if any selection is incomplete, while `--write --all` records only complete pairs and skips incomplete ones.
- `ai-workflow plan validate --plan <directory>` also enforces the triplet — the `.zh.md` and `.i18n.yaml` siblings, the exact switchers, the mirrored structure and recorded hashes equal to the current bytes — while keeping its `plan_id`, count and digest checks and its unchanged success JSON shape (`valid`, `plan_id`, `digests`).
- `readPlan` and `readTasks` enforce the triplet, and task enumeration treats only `task-NNN-slug.md` as a main document; a `.zh.md` or `.i18n.yaml` without a matching main document is an orphan error.
- No configuration selects the planning-artifact language: `output_language` was later removed entirely by the 2026-09-18 [remove output_language record](../simplification/2026-09-18-remove-output-language.md). Notes and planning artifacts are always complete bilingual triplets, and no configuration item selects their languages.
- The implementation reuses the notes pairing primitives in `src/notes/pairing.ts` and adds `src/workflow/pairing.ts` for the plan-specific record, enumeration and validation paths.

## Alternatives considered

- **Migrate the existing single-language plans to triplets.** Declined: the existing plans are historical frozen artifacts, and translating them would rewrite sealed content and blur the boundary between the old and new formats; they keep their bytes and fail the new validation by design.
- **Keep `output_language` as the planning-artifact language selector and add bilingual artifacts only for notes.** Declined: it would leave planning artifacts with no maintained counterpart or drift detection, contradict the one bilingual contract, and keep the old single-language assumption alive for the artifact family this change aligns.
- **Add a third configuration item that selects the artifact languages.** Declined: the triplet is unconditional, so a separate switch would add a configuration surface and a second failure mode with no use case, because both languages carry equal authority rather than a primary and a translation.
- **Give the Chinese side its own frontmatter or a per-language `digest`.** Declined: the digest protocol and the structural fields must stay single-sourced from the English bytes so existing readers, counts and the `plan validate` output shape remain compatible.

## Consequences

- A planning document is a complete pair or it is invalid: a missing `.zh.md` or `.i18n.yaml`, a wrong switcher, a diverging structure, a stale recorded hash and an orphan sidecar all fail `ai-workflow plan validate` with the offending path and reason.
- Existing single-language plans under `.ai-workflow/plans/` fail the new validation by design and are neither migrated nor exempted. The plan directory `20260917-bilingual-planning-artifacts` is itself such a legacy artifact: it was frozen before this change, executes as an unsplit plan, generates no task files and must not be re-validated with the new `plan validate` after landing.
- The digest protocol and the `plan validate` success output shape are preserved, so readers that only need `plan_id`, counts and digests keep working, and no digest-protocol migration is required.
- Drift is caught by the recorded pair hashes rather than by the digest: a Chinese-only edit leaves the English `digest` matching and is reported as `out-of-sync` until `ai-workflow plan pairing --plan <directory> --write --all` re-records the bytes.
- Structure is compared mechanically but meaning is not: semantic review still owns faithfulness, terminology and natural wording.
