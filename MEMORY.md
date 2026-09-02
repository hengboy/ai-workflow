# Project memory

## Purpose

`ai-workflow` installs portable planning, task-splitting and coding skills once into `~/.agents/skills`, and per-host role agents for Codex, Claude Code and OpenCode. Coding execution is handled by this repository's own JSON DAG runtime.

## Boundaries

- `src/install`: shared-skill and host-agent rendering, atomic install/uninstall and project initialization.
- `src/profile`: profile YAML discovery and authoritative schema validation.
- `src/workflow`: frozen-plan parsing, workflow generation, validation, explanation and approval.
- `src/runtime`: persistent state machine, scheduling, checkpoints and lifecycle commands.
- `src/adapters`: one-host-per-run CLI process protocol.
- `src/security`: role, command, read/write and screenshot policy enforcement.
- `src/git`: Git Operator-only worktree lifecycle.
- `src/context`: MEMORY/navigation consistency checks.
- `schemas`: authoritative public protocol contracts.
- `templates`: single-source human-readable skills, roles and project documents.

## Standards

- No external workflow framework and no provider API calls.
- No push, publish, remote mutation, automatic rebase or mixed-host run.
- All side effects use stable idempotency keys and checkpoints.
- User configuration is preserved unless an install manifest proves ownership.
