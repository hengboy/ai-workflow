---
name: setup-ai-workflow
description: Initialize ai-workflow in a project that has not adopted it yet. Use when a user asks to set up or initialize ai-workflow for a project.
---

# Setup AI Workflow

## Outcome

Initialize a project that has not yet adopted ai-workflow using the locally installed `ai-workflow` CLI. Report every result. Do not invoke external orchestrators or provider APIs.

## Required inputs

- The exact project path. Ask for it if the user did not provide one.

## Workflow

1. Run `ai-workflow init <project>` once for first-time setup. Do not scan or modify project files directly.
2. Treat only a zero exit status and parseable JSON as success. Do not edit `AGENTS.md`, `CLAUDE.md`, `MEMORY.md`, `.ai-workflow/`, project templates or any configuration directly.
3. Report every `created` path from the JSON response.

## Failure handling

If the CLI command fails, return its error and do not claim that initialization completed. Do not retry with another path, overwrite conflicts, or install a different ai-workflow release without the user's direction.

## Completion checklist

- The `ai-workflow init <project>` command completed with a zero exit status and parseable JSON.
- The JSON output was parseable and reported accurately.
- Every `created` path was reported.
- Managed files were not edited directly.
