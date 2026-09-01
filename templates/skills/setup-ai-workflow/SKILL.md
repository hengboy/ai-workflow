---
name: setup-ai-workflow
description: Initialize ai-workflow in a project or safely update its unmodified managed templates. Use when a user asks to set up, initialize, update, or upgrade ai-workflow for a project.
---

# Setup AI Workflow

## Outcome

Initialize a project that has not yet adopted ai-workflow, or update an existing ai-workflow project using the locally installed `ai-workflow` CLI. Preserve user-modified managed files and report every result. Do not invoke external orchestrators or provider APIs.

## Required inputs

- The exact project path. Ask for it if the user did not provide one.
- Whether the request is to initialize or update when the requested outcome is not clear.

## Workflow

1. Inspect only `<project>/.ai-workflow/project-manifest.json` to choose the operation. Do not scan or modify project files directly.
2. When the manifest is absent and the user wants first-time setup, run `ai-workflow init <project>` once.
3. When the manifest is present, run `ai-workflow update <project>` once.
4. Treat only a zero exit status and parseable JSON output as success. Do not edit `AGENTS.md`, `MEMORY.md`, `.ai-workflow/`, project templates, or the manifest directly.
5. For `init`, report every `created` path from the JSON response.
6. For `update`, report `updated`, `unchanged`, and `skipped` paths from the JSON response. A `skipped` path was modified by the project user or is not covered by managed history; leave it unchanged and identify it for manual review.

## Legacy projects

When the manifest is absent and the user explicitly requested an update, do not run `init` or create a manifest. Run `ai-workflow update <project>` once so its CLI error can be reported. Explain that the project has no managed history, which may mean it predates safe updates, and its templates must be merged manually before a future update can be safe.

## Failure handling

If a CLI command fails, return its error and do not claim that initialization or updating completed. Do not retry with another path, overwrite conflicts, or install a different ai-workflow release without the user's direction.

## Completion checklist

- Exactly one CLI command was selected from the manifest state and user intent.
- The JSON output was parseable and reported accurately.
- User-modified files were not overwritten.
- Legacy projects were not migrated automatically.
