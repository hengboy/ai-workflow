# Project agent constraints

These instructions are authoritative for every sub-agent. Installed role files contain only host metadata and identity and must not override this file or `CLAUDE.md`.

## Shared context and maintenance

- Before repository work, read `MEMORY.md`, `.ai-workflow/index/navigation.json` and `.ai-workflow/index/navigation.md`.
- For indexed known features, use `ai-workflow context locate --project <absolute-project-root> --feature <id> --verify`; do not search first.
- A missing or empty index is normal for a new project. `missing_index` and a feature `miss` do not by themselves block implementation when the frozen plan supplies an explicit boundary; for an unsplit plan, do not invoke File Explorer merely because the feature is absent from the index. Request bounded File Explorer discovery only when that boundary is unclear. `stale` or `invalid` still require bounded discovery or index repair before relying on indexed paths.
- Navigation JSON is authoritative. Updating `MEMORY.md` and `.ai-workflow/index/navigation.json` is mandatory and immediate whenever architecture, ownership, agent responsibilities, public symbols, paths or workflow rules change. Regenerate and validate `navigation.md` in the same change.
- Agent results are Markdown with `## Output checklist`, followed by `### Status`, `### Summary`, `### Evidence` and `### Support Requests`; File Explorer uses `### Found Paths`. JSON envelopes are prohibited; v2 manifest JSON is unchanged.

## Workflow roles

- Planning asks one business-impact question at a time, obtains approval, and creates frozen `spec.md` and `plan.md`.
- Plan-to-tasks validates the frozen pair, previews the complete graph, obtains approval, and creates immutable `tasks/<taskId>.md` files. It never edits frozen plans.
- Coding depth is proportional: small changes may be implemented directly with focused verification; larger or high-risk changes may use planning, TDD, worktrees, commits and specialist roles when useful or requested. It never creates workflow manifests or run records.
- The primary orchestrator directly dispatches Git Operator and every specialist in dependency order; no coordinator role exists. For split and unsplit coding it directly dispatches Git Operator, File Explorer, the implementation role, Test, both reviews, an optional repair, and finalization.
- Spec Review and Standards Review are available for larger or high-risk changes; they are collaboration guidance, not mandatory runtime gates.

## Agent permissions

- Backend and Frontend edit only exact task write scopes. Frontend screenshots stay under `.ai-workflow/plans/<planId>/screenshot/`.
- Test writes or updates behavior tests only within an explicit delegated test scope, runs only explicitly allowed commands, changes no product code, and reports exit status, evidence, skipped checks and failures truthfully.
- File Explorer is read-only and may search only authorized roots. It never edits files or guesses paths.
- Researcher handles every technology, project, concept, product, topic or keyword research request using public sources and citations. It never edits files.
- Documentation Maintainer owns only explicitly scoped `MEMORY.md`, navigation indexes and non-code documentation. JSON navigation is authoritative and Markdown is generated from it. After completing checks, it returns exact changed paths and validation evidence to the primary orchestrator, which directly dispatches Git Operator for the local commit; it must not invoke Git itself.
- Spec Review checks requirements, acceptance criteria, testability, scope and coverage. Standards Review checks changes against `MEMORY.md`. Both are read-only.
- Git Operator is the only role allowed to run Git, stages only explicit paths, invokes `$git-message` before commits, preserves unrelated changes and performs no remote mutation.
- All agents stop on missing scope, contradictory frozen inputs, infrastructure failure or out-of-scope requests and return a bounded support request. Never weaken tests or silently expand authority.
