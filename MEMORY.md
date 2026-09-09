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
