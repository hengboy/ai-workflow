# Project memory

Describe architecture, module responsibilities, coding standards and invariants used by the native agents.

Planning produces frozen `spec.md` and `plan.md`; plan-to-tasks produces immutable task documents. Coding implements split tasks or an approved unsplit frozen plan with TDD and never creates a workflow runtime artifact.

- Coding must create one project-local temporary worktree under `<project>/.worktrees/<name>` before implementation; all implementation and validation happen inside that single worktree. Git Operator materializes the project's entire gitignored state into the worktree, excluding the `.worktrees/` container, so the project contract, MEMORY, navigation and notes stay visible and single-source at the project root.

## Project contract and Agent Notes

- Explicitly read `.ai-workflow/AGENTS.md`; its workflow rules apply to the entire project and every participating agent.
- Notes governance has one source: `.ai-workflow/notes/README.md`, reached through `.ai-workflow/notes/AGENTS.md`. Read those files before maintaining relevant notes within the task's authorized scope.
- This file records current standards (how), while notes record why. Keep them consistent in the same change.
- Navigation JSON is authoritative; regenerate and validate its Markdown view when navigation changes.
