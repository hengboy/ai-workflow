# Project agent guidance

This file and `AGENTS.md` are the complete shared sub-agent contract. Role files must not override them.

## Required sequence

1. Read `MEMORY.md`, `.ai-workflow/index/navigation.json` and `.ai-workflow/index/navigation.md`.
2. Use `ai-workflow context locate` for known features before any discovery.
3. If the index cannot resolve a feature, request bounded File Explorer discovery with explicit roots.
4. Update `MEMORY.md` and `navigation.json` immediately in the same change whenever architecture, ownership, agent responsibilities, public symbols, paths or workflow rules change, then regenerate and validate `navigation.md`.

Agent results are Markdown under `## Output checklist` using `### Status`, `### Summary`, `### Evidence` and `### Support Requests`; File Explorer uses `### Found Paths`. JSON envelopes are prohibited; v2 manifest JSON is unchanged.

## Architecture decision records

Architecture, module boundaries or ownership, public protocols or schemas, cross-cutting standards, workflow or agent rules, and hard-to-reverse technology choices require an ADR; routine bug fixes, local refactors and formatting changes do not. ADRs are local, uncommitted artifacts under `.ai-workflow/adr/`, discovered by listing that directory and reading each file's self-describing fields; ignore entries that do not match `NNNN-*.md` (for example `notes.md`). There is no index or template file.

Each ADR file is named `NNNN-kebab-title.md` with a 4-digit zero-padded number (`0001`) that is monotonically increasing and never reuses a number: start at `0001` when no ADR exists, otherwise use the maximum existing number plus one. Every ADR states the required fields `Title`, `Status`, `Date`, `Context`, `Decision` and `Consequences`, plus optional `Alternatives`; `Status` is one of `proposed`, `accepted`, `deprecated`, `superseded-by` or `rejected`. An `accepted` ADR is immutable: never edit its `Context`, `Decision` or `Consequences`. To replace one, append only the line `superseded by ADR-NNNN` to the old file and record the new decision in a new ADR.

`MEMORY.md` records the current standards and how the project works; ADRs record the decision history and why it is that way. `MEMORY.md` and ADR inconsistency is a defect: update both in the same change and cite the ADR number from the `MEMORY.md` entry. Update `navigation.json` and regenerate `navigation.md` in the same change.

## Role guidance

- Planning clarifies one business-impact issue per turn, gets explicit approval, and freezes `spec.md` and `plan.md`.
- Plan-to-tasks previews and validates the task graph before creating immutable task files.
- Coding uses delegated TDD for one approved task: Todo list, temporary
  project-local worktree, red-green loop, scoped verification and per-step
  commit. Unsplit plans delegate one sub-agent per step, split plans one per
  task in dependency order, and small bugs or requests as one complete unit.
  The orchestrator continues automatically unless blocked.
- Backend and Frontend edit only exact task scopes; Test writes scoped behavior
  tests when delegated, verifies authorized commands and never changes product
  code. Test authoring must precede implementation when a test is required.
- File Explorer is read-only bounded discovery. Researcher performs cited public research and is read-only.
- Documentation Maintainer updates only authorized `MEMORY.md`, navigation and documentation paths; `navigation.json` is authoritative. After checks, it returns exact changed paths and validation evidence to the primary orchestrator, which directly dispatches Git Operator for the local commit; it must not invoke Git itself.
- Spec Review and Standards Review are read-only gates. The primary orchestrator directly dispatches Git Operator and every specialist; reviewers and specialists never edit or test.
- Git Operator alone runs Git, stages exact paths and uses `$git-message`; no remote mutation or unrelated changes.

All roles must stop and report a bounded support request when scope, evidence or frozen inputs are insufficient. Never weaken checks or expand authority silently.
