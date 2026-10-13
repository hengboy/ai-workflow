---
name: setup-ai-workflow
description: Initialize ai-workflow in a project, or upgrade an existing adoption when the user explicitly authorizes it. Use when a user asks to set up, initialize or upgrade ai-workflow for a project.
---

# Setup AI Workflow

## Scope and context

Use the locally installed `ai-workflow` CLI for user-authorized project initialization or upgrade. Do not invoke external orchestrators or provider APIs.

Before acting, explicitly read the project's `.ai-workflow/AGENTS.md`, `MEMORY.md`, `.ai-workflow/index/navigation.json` and `.ai-workflow/index/navigation.md`, or receive them through complete context injection. A Markdown link or an inherited parent read does not load them into this session. The project contract applies to the whole project and to every participating agent.

Obtain the exact project path; ask for it if the user did not provide one.

## Authorization and entry points

Installing the shared synchronization entry authorizes only the narrow routine preflight that patches the project's management files (the marked workflow instructions). It does not run setup or authorize first adoption or upgrade; both remain explicit user-authorized actions, never inferred from an existing `.ai-workflow/` directory.

Determine whether the project already adopted ai-workflow, then use only the matching entry point:

| Project state and authorization | Command |
| --- | --- |
| First-time setup, no existing adoption | Run `ai-workflow init <project>` once. |
| Existing adoption, only after the user explicitly authorizes an upgrade | Run `ai-workflow init <project> --upgrade`. |

Upgrade fills in missing project-contract and notes management files and directories, preserves existing MEMORY, navigation, plans and note bodies, and stops without writing while prerequisites or rule conflicts remain.

## Writes and results

The synchronization entry and setup perform no Git operation. They write only managed workflow instruction files inside the actual project root or coding worktree and never expand into product scope.

Do not scan or modify project files directly. Do not edit `AGENTS.md`, `CLAUDE.md`, `MEMORY.md`, `.ai-workflow/`, project templates, note bodies or any configuration directly; the CLI owns all writes.

Treat only a zero exit status and parseable JSON as success. Report every `created` path from the JSON response, and for an upgrade also every `skipped` path. Never present a skipped or failed path as created.

On failure, return the CLI error and do not claim initialization completed. Do not retry with another path, overwrite conflicts, resolve rule conflicts outside the authorized scope, or install a different ai-workflow release without the user's direction.
