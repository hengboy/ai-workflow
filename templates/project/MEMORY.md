# Project memory

Describe architecture, module responsibilities, coding standards and invariants used by the native agents.

Planning produces frozen `spec.md` and `plan.md`; plan-to-tasks produces immutable task documents. Coding implements those tasks with TDD and never creates a workflow runtime artifact.

## Architecture decision records

Planning schedules the ADR step; the change that lands the architecture decision writes the ADR file. A decision approved before implementation may be recorded as proposed and becomes accepted in the same change that lands it.

- ADRs are local, uncommitted artifacts under `.ai-workflow/adr/`, discovered by listing that directory and reading each file's self-describing fields; there is no index or template file.
- Name each file `NNNN-kebab-title.md` with a 4-digit zero-padded number (`0001`); never reuse a number and use the maximum existing number plus one.
- Architecture, module boundaries, cross-cutting standards and hard-to-reverse choices require an ADR.
- An `accepted` ADR is immutable; replace it only by appending `superseded by ADR-NNNN` to the old file and recording the new decision in a new ADR.
- This file records current standards (how) while ADRs record decision history (why); an inconsistency is a defect, so update both in the same change and cite the ADR number.
- The full contract lives in the `Documentation Maintainer` and `Standards Review` role files.
