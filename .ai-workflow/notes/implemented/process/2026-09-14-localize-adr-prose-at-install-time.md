# Agent Note: Localize ADR prose at install time

Status: implemented

English | [中文](2026-09-14-localize-adr-prose-at-install-time.zh.md)

## Problem

ADR bodies were authored by the Documentation Maintainer, while `output_language` previously covered only the planning skills. The ADR contract required field names, `Status`, `Supersedes`, `NNNN-kebab-title.md` and `superseded-by ADR-NNNN` to stay English.

## Decision

At install time, inject the configured language directive into the Documentation Maintainer. The ADR's natural-language content is localized to that preference, while structural fields and protocol values stay English.

That mechanism has been superseded. The 2026-09-16 [project contract and Agent Notes replacement record](./2026-09-16-project-contract-and-agent-notes.md) removed the ADR-specific fields and authoring rules, and the 2026-09-18 [remove output_language record](../simplification/2026-09-18-remove-output-language.md) removed the install-time language injection entirely. Notes and planning artifacts are now always complete bilingual triplets, and no configuration selects their languages.

## Alternatives considered

The original record listed no alternatives: the migration preserves that fact and does not backfill options that were not considered at decision time.

## Consequences

- ADR authoring followed the user preference; changing that preference required reinstalling.
- ADR structure and `adr list` output stayed English.
- Those ADR-specific structures are now retired, and the install-time injection was later removed by the 2026-09-18 [remove output_language record](../simplification/2026-09-18-remove-output-language.md). Notes remain bilingual triplets whose prose is translated while the `# Agent Note:` prefix, section headings, field names, `Status` values, paths and dates stay English, see [the project contract and Agent Notes replacement record](./2026-09-16-project-contract-and-agent-notes.md).
