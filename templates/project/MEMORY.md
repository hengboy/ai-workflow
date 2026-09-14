# Project memory

Describe architecture, module responsibilities, coding standards and invariants used by the native agents.

Planning produces frozen `spec.md` and `plan.md`; plan-to-tasks produces immutable task documents. Coding implements those tasks with TDD and never creates a workflow runtime artifact.

## Architecture decision records

Planning schedules the ADR step; the change that lands the architecture decision writes the ADR file. A decision approved before implementation may be recorded as proposed and becomes accepted in the same change that lands it.

- ADRs are local, uncommitted artifacts under `.ai-workflow/adr/`; read `.ai-workflow/adr/INDEX.md`, which lists status and topics, instead of scanning the directory.
- The index is generated: run `ai-workflow adr index --project <root>` and never edit `.ai-workflow/adr/INDEX.md` by hand.
- Name each file `NNNN-kebab-title.md` with a 4-digit zero-padded number (`0001`); never reuse a number and use the maximum existing number plus one.
- Architecture, module boundaries, cross-cutting standards and hard-to-reverse choices require an ADR.
- An `accepted` ADR is immutable; replace it only by cross-linking it with its replacement through the header fields and recording the new decision in a new ADR.
- This file records current standards (how) while ADRs record decision history (why); an inconsistency is a defect, so update both in the same change and reference `.ai-workflow/adr/INDEX.md`.
- The full contract lives in the `Documentation Maintainer` and `Standards Review` role files.
