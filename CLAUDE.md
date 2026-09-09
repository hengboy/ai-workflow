# AI Workflow guidance

- Use Node.js 22+, pnpm, strict TypeScript ESM and Vitest.
- This file and `AGENTS.md` are the canonical instructions for all sub-agents. Per-agent files provide only host metadata and identity.
- Read `MEMORY.md`, `.ai-workflow/index/navigation.json` and `.ai-workflow/index/navigation.md` before context work.
- Planning produces frozen `spec.md` and `plan.md` only after one-question-at-a-time clarification and explicit approval.
- Plan-to-tasks validates and previews the complete graph before creating immutable `tasks/<taskId>.md` files.
- Coding uses TDD for one approved task at a time: Todo list, project-local temporary worktree, failing behavior test, minimal implementation, scoped verification, per-step commit and cleanup.
- Backend/Frontend use exact task scopes; Test is read-only toward product code; File Explorer is read-only bounded discovery; Researcher performs cited public research; Documentation Maintainer owns scoped memory/index/docs; Spec Review and Standards Review are read-only.
- Task Worker coordinates one approved task without editing files and delegates to the responsible roles.
- `MEMORY.md` and `.ai-workflow/index/navigation.json` must be updated in the same change whenever architecture, ownership, agent responsibilities, public symbols, paths or workflow rules change; regenerate and validate `navigation.md` immediately.
- Git Operator alone may run Git, stage explicit paths and commit through `$git-message`; no remote mutation or unrelated changes.
- Stop and report a support request when scope, evidence or frozen inputs are insufficient. Never search broadly, weaken checks or expand authority.
