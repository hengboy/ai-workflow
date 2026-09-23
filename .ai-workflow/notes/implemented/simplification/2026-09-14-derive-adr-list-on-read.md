# Agent Note: Derive the ADR list on read

Status: implemented

English | [中文](2026-09-14-derive-adr-list-on-read.zh.md)

## Problem

An earlier mechanism stored a generated `.ai-workflow/adr/INDEX.md` and protected it with `ai-workflow adr index --verify`. A generated file removed drift caused by manual editing, but the stored copy was still a second artifact: it went stale whenever regeneration was skipped, and it required the workflow to carry an index file that had to be read and refreshed. A projection that never touches disk cannot drift.

## Decision

- Do not store an ADR index file. `.ai-workflow/adr/INDEX.md` was removed and is no longer regenerated.
- `ai-workflow adr list --project <root>` reads the header fields of every `NNNN-*.md` record, ignores entries that do not match `NNNN-*.md` (for example `notes.md`), and prints a deterministic ascending table with the columns `#`, `Status`, `Date`, `Supersedes`, `Superseded-by` and `Summary`.
- Supersession and header fields followed the ADR contract: header fields were the authority, the `Superseded-by` column was derived from `Status: superseded-by ADR-NNNN`, and `accepted` bodies stayed immutable.
- `MEMORY.md` referenced the `ai-workflow adr list` command rather than a file or a concrete ADR number.
- Readers ran the command first to triage status and topic, then opened only the `accepted` and `proposed` ADRs relevant to the change. Running the command needed the CLI; reading ADRs directly did not.

That mechanism has been superseded: the `ai-workflow adr` command and the `.ai-workflow/adr/` records were removed wholesale by the 2026-09-16 [project contract and Agent Notes replacement record](../process/2026-09-16-project-contract-and-agent-notes.md), the current lookup and triage entry moved to `.ai-workflow/notes/` and `ai-workflow notes list`, and this record keeps only the decision and rationale from that time.

## Alternatives considered

- **Keep the generated `INDEX.md` and `--verify`.** Rejected: it only bounded staleness while still storing a second artifact that drifted whenever regeneration was missed.
- **Maintain the index by hand.** Rejected: an independent copy of header fields necessarily drifts.
- **Provide no command and let readers scan the headers themselves.** Rejected: it would lose the only deterministic triage entry, even though it avoided the CLI dependency.

## Consequences

- Drift became structurally impossible: there was no stored index to go stale.
- Every triage read paid for a directory scan and header parsing instead of reading one file; the ADR directory was small enough for that cost to be acceptable.
- Index triage needed the `ai-workflow` CLI, while reading ADRs directly stayed dependency-free plain Markdown.
- The `adr index` command and `--verify` were removed, and `adr list` became the only ADR CLI surface.
- That path no longer exists: there is no `adr` command and no `.ai-workflow/adr/` record; records and triage are provided by `ai-workflow notes list`, see [the project contract and Agent Notes replacement record](../process/2026-09-16-project-contract-and-agent-notes.md).
