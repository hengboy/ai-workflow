---
name: setup-ai-workflow
description: Initialize ai-workflow in a project, or upgrade an existing adoption when the user explicitly authorizes it. Use when a user asks to set up, initialize or upgrade ai-workflow for a project.
---

# Setup AI Workflow

## Outcome

Set up ai-workflow with the locally installed `ai-workflow` CLI: first-time initialization for a project that has not adopted ai-workflow yet, or an upgrade that completes missing management files and directories in an existing project. Run an upgrade only when the user explicitly authorizes it. Report every result. Do not invoke external orchestrators or provider APIs.

## Required inputs

- The exact project path. Ask for it if the user did not provide one.
- For an existing project, the user's explicit authorization to upgrade. Never infer it from the presence of an existing `.ai-workflow/` directory.

## Workflow

1. Determine whether the project has already adopted ai-workflow.
2. First-time setup: run `ai-workflow init <project>` once. This is the only entry point for a project without an existing adoption.
3. Existing project: only after the user explicitly authorizes it, run `ai-workflow init <project> --upgrade`. The upgrade fills in missing project-contract and notes management files and directories, preserves existing MEMORY, navigation, plans and note bodies, and stops without writing while prerequisites or rule conflicts remain.
4. Do not scan or modify project files directly. Do not edit `AGENTS.md`, `CLAUDE.md`, `MEMORY.md`, `.ai-workflow/`, project templates, note bodies or any configuration directly; the CLI owns all writes.
5. Treat only a zero exit status and parseable JSON as success. A non-zero exit status means the setup did not complete: return the CLI's error and do not claim otherwise.
6. Report every `created` path from the JSON response, and for an upgrade also report every `skipped` path. Never present a skipped or failed path as created.

## Failure handling

If the CLI command fails, return its error and do not claim that initialization completed. Do not retry with another path, overwrite conflicts, resolve rule conflicts outside the authorized scope, or install a different ai-workflow release without the user's direction.

## Completion checklist

- The command was `ai-workflow init <project>` for a first-time setup, or `ai-workflow init <project> --upgrade` after explicit user authorization for an existing project.
- The command completed with a zero exit status and parseable JSON.
- The JSON output was parseable and reported accurately, distinguishing `created` from `skipped`.
- Every `created` path was reported, and for an upgrade every `skipped` path was reported too.
- Managed files were not edited directly.
