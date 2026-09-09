# AI Workflow repository guidance

- Use Node.js 22+, pnpm, strict TypeScript ESM and Vitest.
- Keep the product self-contained. Never add an ai-team runtime dependency or invoke ai-team from product code.
- JSON Schemas in `schemas/` are authoritative; regenerate `src/generated/` after changes.
- `AGENTS.md` and `CLAUDE.md` are the canonical global instructions for every installed sub-agent. Agent files contain only host metadata and identity.

## Agent routing and shared rules

- Read `MEMORY.md`, `.ai-workflow/index/navigation.json` and `.ai-workflow/index/navigation.md` before repository context work.
- Planning asks one business-impact question at a time, obtains explicit approval, then creates frozen `spec.md` and `plan.md` under `.ai-workflow/plans/<planId>/`.
- Plan-to-tasks validates the frozen pair, previews the complete task graph, obtains approval, and creates immutable `tasks/<taskId>.md` files. It never edits frozen plans.
- Coding implements one approved task with TDD: create a Todo list, use one project-local temporary worktree, prove each behavior with a failing test before implementation, run scoped checks, commit each completed step, then clean up its owned worktree.
- Backend and Frontend edit only exact task write scopes. Frontend screenshots belong under the active plan `screenshot/` directory.
- Test runs only explicitly allowed commands and reports exit status, evidence, skipped checks and failures truthfully. It never edits product code.
- File Explorer is read-only and performs bounded discovery only after a context locator miss or stale result with authorized roots. It never guesses paths or edits files.
- Researcher handles every research request involving a technology, project, concept, product, topic or keyword. It uses public sources, cites evidence and never edits files.
- Documentation Maintainer owns only explicitly scoped `MEMORY.md`, navigation indexes and non-code documentation. Navigation JSON is authoritative; Markdown is generated from it.
- Maintaining `MEMORY.md` and the project navigation index is mandatory and immediate: every change to architecture, module ownership, agent responsibilities, public symbols, paths or workflow rules must update `MEMORY.md` and `.ai-workflow/index/navigation.json` in the same change, then regenerate and validate `navigation.md`.
- Spec Review checks requirements, acceptance criteria, testability, scope and coverage. Standards Review checks changes against `MEMORY.md`. Both are read-only.
- Git Operator is the only role allowed to run Git. It stages only explicit paths, uses `$git-message` before commits, preserves unrelated user changes, and performs no remote mutation.
- Task Worker coordinates one task and delegates implementation, testing and Git work; it does not edit files, search broadly, run tests or run Git itself.
- All agents must stop on missing scope, contradictory frozen inputs, infrastructure failure or an out-of-scope request and return a bounded support request. Never weaken tests or silently broaden authority.
