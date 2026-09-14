# Project memory

## Purpose

`ai-workflow` installs portable planning, task-splitting and TDD coding skills once into `~/.agents/skills`, and per-host role agents for Codex, Claude Code and OpenCode.

## Boundaries

- `src/install`: shared-skill and host-agent rendering, atomic install/uninstall, and transactional project initialization/update with conflict preflight, actual-byte manifest digests and invocation-scoped rollback; resolves the active profile from `config.yaml` and performs a one-time migration of the deprecated `~/.config/ai-workflow/active-profile` marker (validate the candidate before any write, migrate and delete the marker only after a successful install or explicit activation, keep it on failure); `uninstall` never changes `config.yaml`.
- `src/profile`: profile YAML discovery, authoritative schema validation and legacy-role migration rejection.
- `src/settings`: validates and reads the whole user-owned `~/.config/ai-workflow/config.yaml` (`output_language` plus optional `active_profile`), resolving `en`/`zh-CN` (default `en`), exposes `writeActiveProfile` to update `active_profile` while preserving existing keys, and fails before installation writes on unsupported or malformed configuration.
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
- Install resolves the output language before any write and injects it into the installed `planning`, `plan-to-tasks` and `coding` skills, covering the agent's session/interactive prose (clarification questions, confirmation previews, progress narration, final summary) and generated planning-artifact prose while headings, table headers, frontmatter, identifiers, paths, code and enumerated values stay English; changing the language requires re-running `ai-workflow install` or `$switch-profile` because the directive is injected at install time.
- Repository navigation is discovered from repository evidence and optional user-owned `.ai-workflow/project.yml`; the tool never generates, overwrites or claims ownership of that configuration.
- Navigation JSON is authoritative and `navigation.md` is rendered from it. Structural `file` roots are validated by file existence and coverage; semantic `exported-symbol` roots by symbols and relations, except mixed-language roots, which full validation exempts (feature-scoped verification still checks indexed symbols and relations); unsupported semantic languages are rejected.
- Project init validates configuration and the navigation model before publication, records actual written-byte digests, and on ordinary failure removes only invocation-created files and restores the original `.gitignore`.
- `update` unconditionally skips both navigation files, never replacing generated navigation with empty templates or recreating missing navigation; other managed templates keep their ownership rules.
- After Documentation Maintainer's documentation checks pass, the primary orchestrator directly dispatches Git Operator for that local commit, with exact changed paths and evidence.
- The `task-worker` role is removed; the primary orchestrator directly dispatches every specialist and Git Operator, and legacy profiles referencing `task-worker` are rejected before any mutation.
- Coding must create one project-local temporary worktree under `<project>/.worktrees/<name>` before implementation, with Git Operator creating it and `.gitignore` containing `.worktrees/`; all implementation, validation and per-step commits happen inside that single worktree. Planning, TDD and review depth remain proportional to change risk. This mandatory worktree policy is recorded in `ADR-0002` (`.ai-workflow/adr/0002-project-local-worktree-policy.md`).
- Coding may implement a frozen plan directly when no task split exists; a
  missing or empty navigation index is valid initial-project state and does not
  block implementation when the plan provides the scope.
- Agent results use Markdown with `Status`, `Summary`, `Evidence` and `Support
  Requests`; File Explorer uses `Found Paths`. JSON envelopes are prohibited. v2 manifest JSON is unchanged.
- Architecture Decision Records (ADRs) are local, uncommitted artifacts under `<project>/.ai-workflow/adr/`, discovered by listing that directory and reading each file's self-describing fields; ignore entries that do not match `NNNN-*.md` and there is no index or template file. Each ADR is named `NNNN-kebab-title.md` with a 4-digit zero-padded number (`0001`) that is monotonically increasing and never reuses a number: start at `0001` when no ADR exists, otherwise use the maximum existing number plus one. Every ADR states the required fields `Title`, `Status`, `Date`, `Context`, `Decision` and `Consequences`, plus optional `Alternatives`, and `Status` is one of `proposed`, `accepted`, `deprecated`, `superseded-by` or `rejected`. An `accepted` ADR is immutable: never edit its `Context`, `Decision` or `Consequences`; to replace one append only the line `superseded by ADR-NNNN` to the old file and record the new decision in a new ADR. `MEMORY.md` records the current standards (how the project works) while ADRs record the decision history (why); an inconsistency is a defect, so update both in the same change and cite the ADR number from the `MEMORY.md` entry. This mechanism is itself recorded in `ADR-0001` (`.ai-workflow/adr/0001-record-architecture-decisions.md`).
