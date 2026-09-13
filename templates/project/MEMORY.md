# Project memory

Describe architecture, module responsibilities, coding standards and invariants used by the native agents.

Planning produces frozen `spec.md` and `plan.md`; plan-to-tasks produces immutable task documents. Coding implements those tasks with TDD and never creates a workflow runtime artifact.

## Architecture decision records

This file records the current standards and how the project works. ADRs record the decision history and why the project is that way; an inconsistency between `MEMORY.md` and an ADR is a defect, so update both in the same change and cite the ADR number from the relevant `MEMORY.md` entry.

ADRs are local, uncommitted artifacts under `.ai-workflow/adr/`, discovered by listing that directory and reading each file's self-describing fields; ignore entries that do not match `NNNN-*.md` (for example `notes.md`). There is no index or template file. Record an ADR when architecture, module boundaries or ownership, public protocols or schemas, cross-cutting standards, workflow or agent rules, or a hard-to-reverse technology choice changes; routine bug fixes, local refactors and formatting changes do not need one.

Each ADR file is named `NNNN-kebab-title.md` with a 4-digit zero-padded number (`0001`) that is monotonically increasing and never reuses a number: start at `0001` when no ADR exists, otherwise use the maximum existing number plus one. Every ADR states the required fields `Title`, `Status`, `Date`, `Context`, `Decision` and `Consequences`, plus optional `Alternatives`; `Status` is one of `proposed`, `accepted`, `deprecated`, `superseded-by` or `rejected`. An `accepted` ADR is immutable: never edit its `Context`, `Decision` or `Consequences`. To replace one, append only the line `superseded by ADR-NNNN` to the old file and record the new decision in a new ADR.
