# Project memory

Describe architecture, module responsibilities, coding standards and invariants used by the native agents.

Planning produces frozen `spec.md` and `plan.md`; plan-to-tasks produces immutable task documents. Coding implements direct changes without planning artifacts and planned work as split tasks or an approved unsplit frozen plan, with TDD, and creates no workflow runtime artifact other than the single implementation record at `<project>/.ai-workflow/plans/<planId>/implementation.yaml`, which holds `plan_id` with `status: in-progress` and an ISO 8601 `started_at` before the first implementation step and becomes `status: completed` with `completed_at` and the final commit SHA after the final merge and owned cleanup; it is the only permitted run record.

- Requests are classified before work starts: a small requirement, feature adjustment or defect fix with clear, bounded intent is implemented directly without Planning or the dual-axis review, while a new feature, unclear or contested requirements, or a public-interface, persistent-format, cross-module, cross-stack, migration, compatibility or contract change runs Planning and keeps that review gate. A planned change without a frozen plan is planned first and then handed off: the planning session ends with the frozen plan path and an instruction to start a new session and invoke the coding skill, never an automatic implementation start.
- Coding must create one project-local temporary worktree under `<project>/.worktrees/<name>` before implementation; all implementation and validation happen inside that single worktree. Git Operator materializes the project's entire gitignored state into the worktree, excluding the `.worktrees/` container, so `.ai-workflow/plans/` stays visible and single-source at the project root while the project contract, MEMORY, navigation and notes arrive with the worktree through Git.

## Host role agents

- Installed role agents are native to each host: Codex uses TOML with `model`/`model_reasoning_effort`, Claude uses Markdown with `allowed-tools`, and OpenCode uses Markdown with `mode: subagent` and ordered `permissions` rules. The role's declared tools remain the single source, and only the primary orchestrator dispatches subagents.

## Project contract and Agent Notes

- Explicitly read `.ai-workflow/AGENTS.md`; its workflow rules apply to the entire project and every participating agent.
- Notes governance has one source: `.ai-workflow/notes/README.md`, reached through `.ai-workflow/notes/AGENTS.md`. Read those files before maintaining relevant notes within the task's authorized scope.
- This file records current standards (how), while notes record why. Keep them consistent in the same change.
- Navigation JSON is authoritative; regenerate and validate its Markdown view when navigation changes.
