# Project memory

## Purpose

`ai-workflow` installs portable planning, task-splitting and TDD coding skills once into `~/.agents/skills`, and per-host role agents for Codex, Claude Code and OpenCode.

## Boundaries

- `src/install`: shared-skill and host-agent rendering, atomic install/uninstall, and transactional project initialization/update with conflict preflight, actual-byte manifest digests and invocation-scoped rollback.
- `src/profile`: profile YAML discovery, authoritative schema validation and legacy-role migration rejection.
- `src/workflow`: frozen-plan parsing and digest validation.
- `src/context`: navigation lifecycle — capability-dispatched validation, verified locate and authorized refresh.
- `src/context/discovery`: deterministic bounded repository scanning, optional user-owned `.ai-workflow/project.yml`, TypeScript/JavaScript semantic `exported-symbol` adapters via the TypeScript compiler, Java structural `file` adapters, and canonical navigation building.
- `schemas`: authoritative public protocol contracts.
- `templates`: single-source human-readable skills, roles and project documents.

## Standards

- No external workflow framework and no provider API calls.
- No push, publish, remote mutation, automatic rebase or mixed-host run.
- Planning artifacts are frozen and validated before task splitting.
- Planning and plan-to-tasks never commit their artifacts: `.ai-workflow/` is gitignored, so `spec.md`, `plan.md` and task files remain local, untracked files.
- User configuration is preserved unless an install manifest proves ownership.
- Repository navigation is discovered from repository evidence and optional user-owned `.ai-workflow/project.yml`; the tool never generates, overwrites or claims ownership of that configuration.
- Navigation JSON is authoritative and `navigation.md` is rendered from it. Structural `file` roots are validated by file existence and coverage; semantic `exported-symbol` roots by symbols and relations, except mixed-language roots, which full validation exempts (feature-scoped verification still checks indexed symbols and relations); unsupported semantic languages are rejected.
- Project init validates configuration and the navigation model before publication, records actual written-byte digests, and on ordinary failure removes only invocation-created files and restores the original `.gitignore`.
- `update` unconditionally skips both navigation files, never replacing generated navigation with empty templates or recreating missing navigation; other managed templates keep their ownership rules.
- After Documentation Maintainer's documentation checks pass, the primary orchestrator directly dispatches Git Operator for that local commit, with exact changed paths and evidence.
- The `task-worker` role is removed; the primary orchestrator directly dispatches every specialist and Git Operator, and legacy profiles referencing `task-worker` are rejected before any mutation.
- Coding requires exactly one post-implementation Spec Review and Standards Review; findings are presented to the user for repair selection before any worktree merge.
- Coding may implement a frozen plan directly when no task split exists; a
  missing or empty navigation index is valid initial-project state and does not
  block implementation when the plan provides the scope.
- Agent results use Markdown with `Status`, `Summary`, `Evidence` and `Support
  Requests`; File Explorer uses `Found Paths`. JSON envelopes are prohibited. v2 manifest JSON is unchanged.
