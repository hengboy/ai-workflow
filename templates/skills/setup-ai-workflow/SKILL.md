---
name: setup-ai-workflow
description: Initialize ai-workflow in a project, or upgrade an existing adoption when the user explicitly authorizes it. Use when a user asks to set up, initialize or upgrade ai-workflow for a project.
---

# Setup AI Workflow

## Scope and context

Use the locally installed `ai-workflow` CLI for user-authorized project initialization or upgrade. Do not invoke external orchestrators or provider APIs.

Determine the actual adoption state before loading context. For an existing adoption, explicitly read the project's `.ai-workflow/AGENTS.md` and `MEMORY.md`, or receive them through complete context injection; read `.ai-workflow/index/navigation.json` or its `.ai-workflow/index/navigation.md` catalog only for a needed bounded entry or an authorized lookup. A Markdown link or an inherited parent read does not load them into this session. A project with no `.ai-workflow/` has never adopted ai-workflow: ordinary `init` never requires nonexistent workflow files first, and it creates the contract, `MEMORY.md` and navigation. The project contract applies to the whole project and to every participating agent once adopted.

Obtain the exact project path; ask for it if the user did not provide one.

## Authorization and entry points

Installing the shared synchronization entry authorizes only the narrow routine preflight that patches the project's management files (the marked workflow instructions). The preflight and directory presence never authorize or grant init or setup; both remain explicit user-authorized actions, never inferred from an existing `.ai-workflow/` directory.

Use only the entry point matching the actual adoption state and the user's explicit authorization:

| Project state and authorization | Command |
| --- | --- |
| First-time setup, no existing adoption, after the user explicitly authorizes setup | Run `ai-workflow init <project>` once. |
| Existing adoption with its upgrade prerequisites present, only after the user explicitly authorizes an upgrade | Run `ai-workflow init <project> --upgrade`. |

An existing adoption with its prerequisites present uses `init --upgrade` only after that explicit authorization: it requires the `.ai-workflow/` directory, `MEMORY.md`, `.ai-workflow/index/navigation.json` and `.ai-workflow/index/navigation.md`. Missing prerequisites return an exact-path support request without overwriting local data; never substitute ordinary `init`, an upgrade of a different path or a hand edit. Upgrade fills in missing project-contract and notes management files and directories, preserves existing MEMORY, navigation, plans and note bodies, and stops without writing while prerequisites or rule conflicts remain.

## Writes and results

The synchronization entry and setup perform no Git operation. They write only managed workflow instruction files inside the actual project root or coding worktree and never expand into product scope.

Do not scan or modify project files directly. Do not edit `AGENTS.md`, `CLAUDE.md`, `MEMORY.md`, `.ai-workflow/`, project templates, note bodies or any configuration directly; the CLI owns all writes.

Treat only a zero exit status and parseable JSON as success. Report every `created` path from the JSON response, and for an upgrade also every `skipped` path. Never present a skipped or failed path as created.

An upgrade uses the shipped local templates, so its `SyncReport` may be `needs_attention` with `proceed: true`: that is a warning outcome with no upstream-freshness claim, not a failure. A manual warning report exits 2; exit 2 alone is not an execution failure when the report proceeds. Never infer the next action from the process exit code alone.

On failure, return the CLI error and do not claim initialization completed. Do not retry with another path, overwrite conflicts, resolve rule conflicts outside the authorized scope, or install a different ai-workflow release without the user's direction.
