# Project memory

## Purpose

`ai-workflow` installs portable planning, task-splitting and TDD coding skills once into `~/.agents/skills`, and per-host role agents for Codex, Claude Code and OpenCode.

## Boundaries

- `src/install`: shared-skill and host-agent rendering, atomic install/uninstall and project initialization.
- `src/profile`: profile YAML discovery and authoritative schema validation.
- `src/workflow`: frozen-plan parsing and digest validation.
- `src/context`: MEMORY/navigation consistency checks.
- `schemas`: authoritative public protocol contracts.
- `templates`: single-source human-readable skills, roles and project documents.

## Standards

- No external workflow framework and no provider API calls.
- No push, publish, remote mutation, automatic rebase or mixed-host run.
- Planning artifacts are frozen and validated before task splitting.
- User configuration is preserved unless an install manifest proves ownership.
- Documentation Maintainer delegates the local commit to Git Operator after documentation checks pass, providing exact changed paths and evidence.
- Coding requires exactly one post-implementation Spec Review and Standards Review; findings are presented to the user for repair selection before any worktree merge.
- Coding may implement a frozen plan directly when no task split exists; a
  missing or empty navigation index is valid initial-project state and does not
  block implementation when the plan provides the scope.
- Agent results use Markdown with `Status`, `Summary`, `Evidence` and `Support
  Requests`; File Explorer uses `Found Paths`. JSON envelopes and
  `result.schema.json` are prohibited. v2 manifest JSON is unchanged.
