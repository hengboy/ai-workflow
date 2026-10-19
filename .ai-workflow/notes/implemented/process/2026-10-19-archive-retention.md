# Agent Note: Archive the spent ADR-era records

Status: implemented

English | [中文](2026-10-19-archive-retention.zh.md)

## Problem

The one-time migration that moved the retired ADR files into Agent Notes deliberately deferred the final retention decision for the migrated cluster: it kept every migrated record active and left any archive step to a later change, because archiving removes a record from `ai-workflow notes list` and needed its own review of future guidance value. That deferral left the cluster without a recorded assessment, so a reader could not tell which migrated records still guide future work and which exist only as history.

## Decision

- Archive [localize ADR prose at install time](../../archived/process/2026-09-14-localize-adr-prose-at-install-time.md) and [migrate retired ADR records to notes](../../archived/process/2026-09-17-migrate-retired-adr-records-to-notes.md) under `archived/process/`. Both are completed implemented decisions whose future guidance is spent while their historical decision value remains, which is the archive outcome the retention policy owned by `.ai-workflow/notes/README.md` reserves for that case.
- The localize record's mechanism is fully retired: the ADR-specific structural fields and authoring rules were removed, and the install-time language injection went with the `output_language` feature. It is kept to explain why install-time localization existed and to keep the supersession chain readable.
- The migrate record describes a completed one-time local data migration whose original bytes no longer exist and whose outcome no future workflow step depends on. It is kept as the account of why the migration was a manual one-time action with no productized conversion path.
- Keep [derive the ADR list on read](../simplification/2026-09-14-derive-adr-list-on-read.md) active: its decision to derive a projection on read rather than store a generated copy still guides how the project treats derived artifacts such as the navigation index and note lookup, and its declined alternatives remain relevant to that choice.
- Keep [move the agent contract into user-level global instruction files](../architecture/2026-09-14-user-level-agent-contract.md) active: the user-level marker-block mechanism, its ownership record and its history rationale remain in force, and only the level at which the full contract text lives changed.
- This disposition is the assessment the migration record deferred; it completes that record's open question rather than changing any recorded decision.

## Alternatives considered

- **Keep all migrated records active.** Declined because two of them no longer guide future work, and leaving them active blurs which records still carry current rationale from those kept only as history.
- **Delete the two spent records.** Declined because both retain historical decision value, and deletion is reserved for records without lasting decision value; it is also irreversible and would drop the only account of the one-time migration.
- **Archive the still-guiding records as well.** Declined because the derive-on-read principle and the user-level marker-block mechanism still guide future work, so archiving them would remove reachable current guidance.

## Consequences

- `ai-workflow notes list` reports only the records that still guide current work, while `ai-workflow notes list --archived` reports the two spent ADR-era records as sealed history.
- The archived localize and migrate records are frozen: their bytes and the archive date are protected by the archive manifest, and their outbound links are no longer repaired.
- The active inbound links in [remove the output_language configuration](../simplification/2026-09-18-remove-output-language.md) and [project contract and Agent Notes replacement](./2026-09-16-project-contract-and-agent-notes.md) point at the archived paths, so an active reader resolves each historical reference.
- The two records kept active continue to explain their current mechanisms, so future work on derived projections and user-level entry ownership still has a reachable rationale.
