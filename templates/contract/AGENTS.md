# ai-workflow agent contract

This contract applies only in a project whose root contains `.ai-workflow/`. It is installed once at the user level and shared by every host; project-local instructions, when present, take precedence.

These instructions are authoritative for every sub-agent. Installed role files contain only host metadata and identity and must not override them.

## Shared context and maintenance

- Before repository work, read `MEMORY.md`, `.ai-workflow/index/navigation.json` and `.ai-workflow/index/navigation.md`.
- For indexed known features, use `ai-workflow context locate --project <absolute-project-root> --feature <id> --verify`; do not search first.
- A missing or empty index is normal for a new project. `missing_index` and a feature `miss` do not by themselves block implementation when the frozen plan supplies an explicit boundary; request bounded File Explorer discovery only when that boundary is unclear. For an unsplit plan, do not invoke File Explorer merely because the feature is absent from the index. `stale` or `invalid` still require bounded discovery or index repair before relying on indexed paths.
- Navigation JSON is authoritative. Updating `MEMORY.md` and `.ai-workflow/index/navigation.json` is mandatory and immediate whenever architecture, ownership, agent responsibilities, public symbols, paths or workflow rules change. Regenerate and validate `navigation.md` in the same change.
- Agent results are Markdown under `## Output checklist` with `### Status`, `### Summary`, `### Evidence` and `### Support Requests`; File Explorer uses `### Found Paths`. JSON envelopes are prohibited; v2 manifest JSON is unchanged.

## Architecture decision records

Planning schedules the ADR step; the change that lands the architecture decision writes the ADR file. A decision approved before implementation may be recorded as proposed and becomes accepted in the same change that lands it.

- ADRs are local, uncommitted artifacts under `.ai-workflow/adr/`; run `ai-workflow adr list --project <root>` to list status and topics instead of scanning the directory.
- Name each file `NNNN-kebab-title.md` with a 4-digit zero-padded number (`0001`); never reuse a number and use the maximum existing number plus one.
- Architecture, module boundaries, cross-cutting standards and hard-to-reverse technology choices require an ADR.
- An `accepted` ADR is immutable; to replace one, cross-link it with its replacement through the header fields and record the new decision in a new ADR.
- `MEMORY.md` records the current standards (how) while ADRs record the decision history (why); update both in the same change. The full ADR contract lives in the `Documentation Maintainer` and `Standards Review` role files.

## Workflow roles

- Planning asks one business-impact question at a time, obtains approval, and creates frozen `spec.md` and `plan.md`.
- Plan-to-tasks validates the frozen pair, previews the complete graph, obtains approval, and creates immutable `tasks/<taskId>.md` files. It never edits frozen plans.
- Coding creates one project-local temporary worktree under `<project>/.worktrees/<name>` before implementation and performs all implementation, validation and per-step commits inside that single worktree; planning, TDD and review depth remain proportional to risk. Git Operator materializes the project's entire gitignored state into the worktree, excluding the `.worktrees/` container, so frozen artifacts, `MEMORY.md` and navigation stay visible and single-source at the project root. It never creates workflow manifests or run records.
- Backend and Frontend edit only exact task write scopes; Frontend screenshots stay under `.ai-workflow/plans/<planId>/screenshot/`.
- Test writes or updates behavior tests only within an explicit delegated test scope, runs only explicitly allowed commands, changes no product code, and reports exit status, evidence, skipped checks and failures truthfully.
- File Explorer is read-only and may search only authorized roots. It never edits files or guesses paths.
- Researcher handles every technology, project, concept, product, topic or keyword research request using public sources and citations. It never edits files.
- Documentation Maintainer owns explicitly scoped `MEMORY.md`, navigation indexes and non-code documentation, returns exact changed paths and validation evidence to the primary orchestrator, and must not invoke Git itself.
- Spec Review checks requirements, acceptance criteria, testability, scope and coverage. Standards Review checks changes against `MEMORY.md`. Both are read-only.
- Git Operator is the only role allowed to run Git, stages only explicit paths, invokes `$git-message` before commits, preserves unrelated changes and performs no remote mutation.

## Orchestration

The primary orchestrator directly dispatches Git Operator and every specialist in dependency order; no coordinator role exists. For split and unsplit coding it directly dispatches Git Operator, File Explorer, the implementation role, Test, both reviews, an optional repair, and finalization. After the Documentation Maintainer returns exact changed paths and validation evidence, the primary orchestrator directly dispatches Git Operator for the local commit. All agents stop on missing scope, contradictory frozen inputs, infrastructure failure or out-of-scope requests and return a bounded support request. Never weaken tests or silently expand authority.
