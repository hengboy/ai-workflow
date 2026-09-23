# Agent Note: Implementation record UTC+08:00 timestamps

Status: implemented

English | [中文](2026-09-23-implementation-record-utc-offset.zh.md)

## Problem

[The implementation record](./2026-09-22-plan-implementation-record.md) required ISO 8601 `started_at` and `completed_at` values but left their timezone open, so a run could write a UTC `Z` value while the maintainers who read the record work in UTC+08:00. Every read then needs a mental conversion, and records written on differently configured machines could carry offsets that hide their true order.

## Decision

- The `implementation.yaml` `started_at` and `completed_at` values are ISO 8601 in the UTC+08:00 timezone, for example `2026-09-23T15:04:05+08:00`. A `Z` suffix or any other offset is not acceptable.
- The requirement is stated together by the `coding` skill in `templates/skills/coding/SKILL.md`, the project contract in `templates/project/AGENTS.md` and `.ai-workflow/AGENTS.md`, the project memory in `templates/project/MEMORY.md` and `MEMORY.md`, and `README.md`; `tests/behavior/implementation-record.test.ts` guards the shipped text.
- Existing records are not rewritten or migrated: the record is local runtime state, and the change applies to records written after the installed host text is refreshed.

## Alternatives considered

- **Keep UTC (`Z`) timestamps.** Declined: the record's only readers work in UTC+08:00, so a UTC value forces a conversion on every read of the single timing record.
- **Follow the writing machine's local zone instead of pinning one.** Declined: machines in different local zones would produce records whose offsets hide the true order of runs.
- **Write a naive UTC+08:00 time without an offset.** Declined: an offsetless value is not a complete ISO 8601 instant and reintroduces the ambiguity this decision removes.
- **Add a configurable timezone setting or CLI validation.** Declined: the project has one timezone, the record is local state that `plan validate` and `plan pairing` ignore, and no configuration or validation surface is needed.

## Consequences

- Every new `implementation.yaml` reads in the maintainers' local time without conversion, and records written on differently configured machines stay directly comparable.
- [The implementation record](./2026-09-22-plan-implementation-record.md) stays current in full; this record only pins the timezone it left open, and no other active note is superseded.
- The installed skill, contract and memory text carry the rule only after the next host install or profile activation.
