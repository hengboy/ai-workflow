# Agent Note: Bilingual note triplets with a consistency record

Status: implemented

English | [中文](2026-09-17-bilingual-note-triplets.zh.md)

## Problem

Notes were single-language: each note body followed the configured `output_language`, and the governance explicitly prohibited translation pairs and sidecars. A reader who did not share the authoring language had no maintained counterpart, nothing mechanically detected when an edited note drifted from its other-language text, and there was no recorded state of when the two sides last agreed. The previous [project contract and Agent Notes replacement record](./2026-09-16-project-contract-and-agent-notes.md) chose that single-language model deliberately, so changing it required a new record rather than rewriting the old decision.

## Decision

- Every note is a sibling triplet in one directory: the English `{topic}.md`, the Chinese `{topic}.zh.md` and the `{topic}.i18n.yaml` consistency record. Both languages carry equal authority and must say the same thing.
- Both bodies keep the English structural elements — the `# Agent Note:` prefix, section headings, field names, `Status` and its values, paths and dates — and translate only the prose. After the header block and before `## Problem`, the English body carries a switcher labelled `中文` that links to `{topic}.zh.md`, and the Chinese body carries a switcher labelled `English` that links to `{topic}.md`.
- `<topic>.i18n.yaml` holds a header comment and exactly two lines mapping each side's basename to the git blob hash recorded at the last confirmed-consistent state. The hash is the git blob SHA-1 (`sha1("blob <length>\0" + bytes)`), computed directly without invoking git.
- The triplet is unconditional: no configuration selects the languages of notes or planning artifacts, and both artifact families are always written as complete bilingual triplets; the `output_language` key was later removed entirely by the 2026-09-18 [remove output_language record](../simplification/2026-09-18-remove-output-language.md), see the [planning-artifact triplets record](./2026-09-17-bilingual-planning-artifacts.md).
- `ai-workflow notes list` reports the English body of each active note; `ai-workflow notes validate` additionally checks triplet completeness, the language switchers, the mirrored heading, code, table, list and link signature, the recorded hashes, active links and archive integrity; `ai-workflow notes pairing` verifies pairs, `--list` reports `missing`, `out-of-sync` or `ok`, and `--write <note>` or `--write --all` records the current bytes.
- Archive sealing registers all three artifacts of each archived triplet in `archived/manifest.json`, and validation requires archived artifacts and manifest entries to correspond one-to-one.
- The shipped `templates/project/notes/README.md` governance, the `documentation-maintainer` role, `MEMORY.md` and `README.md` describe the same triplet contract in the same change.

## Alternatives considered

- **Keep single-language notes and rely on `output_language`.** Declined: it leaves no maintained counterpart, no drift detection and no consistency state, which is what this change was requested to fix.
- **Record a content `sha256` instead of the git blob hash.** Declined: the request was to stay consistent with the reference project's `i18n.yaml`, whose blob-hash format lets the same value be compared against `git hash-object` output.
- **Add a Markdown AST dependency for the structural signature.** Declined: a bounded line-based signature over the constrained note format detects the same heading, code, table, list and link divergence without a new dependency.
- **Let `output_language` select the authoring-first language while still producing both sides.** Declined: both languages carry equal authority, so a preference that ranks one side would contradict the pair contract and keep the old single-language assumption alive.
- **Reproduce the reference project's full pairing contract, including its merge driver and translation brief.** Declined: those mechanisms are tied to that repository's Git hosting and translation tooling; notes need the triplet, the recorded hashes, the switchers and the structural check.

## Consequences

- A note is a complete pair or it is invalid: a missing `.zh.md` or `.i18n.yaml`, a missing or wrong language switcher, a diverging structure, a stale recorded hash and an orphan sibling all fail `ai-workflow notes validate` with the offending path and reason.
- Re-recording is an explicit, reviewable act: `--write` requires the pairs that were confirmed, and `--write --all` re-records the corpus as an explicit choice, so a stale hash is never silently blessed.
- The recorded blob hashes recover the last confirmed text of either side, so an out-of-sync pair is updated by minimally patching the counterpart against the edited side and then re-recording.
- Structure is compared mechanically but meaning is not: the check cannot judge whether the two sides say the same thing, and semantic review still owns faithfulness, terminology and natural wording.
- The `i18n.yaml` header names `.ai-workflow/notes/README.md` and the `ai-workflow notes pairing --write` command instead of a host-specific script runner.
