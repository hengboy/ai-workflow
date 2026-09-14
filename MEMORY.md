# Project memory

## Standards

- Coding must create one project-local temporary worktree under `<project>/.worktrees/<name>` before implementation; all implementation, validation and per-step commits happen inside that single worktree, with `.worktrees/` in `.gitignore`. Git Operator materializes the project's entire gitignored state into the worktree (excluding the `.worktrees/` container), so the frozen plan, `MEMORY.md`, navigation, ADRs, dependencies and build outputs stay visible and single-source at the project root.
- Documentation Maintainer owns explicitly scoped documentation only: `MEMORY.md`, navigation indexes, README files and other non-code documentation. It does not edit source, tests, schemas, frozen plans or task files, and returns exact paths and validation evidence to the primary orchestrator for Git Operator.
- When documenting architecture or module boundaries, use English structural elements and explicitly name modules, boundaries, ownership and related structural terms; prose language preferences do not translate structural elements.
- Install resolves `output_language` before writes and injects it into `planning`, `plan-to-tasks`, `coding` and `documentation-maintainer`; ADR natural-language prose follows it, while structural elements, field names, `Status`, `Supersedes`, `NNNN-kebab-title.md` and `superseded-by ADR-NNNN` remain English. This is a user preference and prose-language inconsistency is not merge-blocking; changing it requires reinstalling.
- ADRs are local artifacts under `.ai-workflow/adr/`; use `ai-workflow adr list --project <root>` rather than individual ADR numbers.
- Navigation JSON is authoritative and Markdown is generated from it.
