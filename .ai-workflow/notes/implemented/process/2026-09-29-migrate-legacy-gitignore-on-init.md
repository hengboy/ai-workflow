# Agent Note: Migrate legacy .gitignore exclusions on init and upgrade

Status: implemented

English | [中文](2026-09-29-migrate-legacy-gitignore-on-init.zh.md)

## Problem

Earlier ai-workflow versions wrote a whole-tree `.ai-workflow/` entry plus `*.log` and `MEMORY.md` into a project `.gitignore`, and shared project templates carried the same block. Once the project contract, `MEMORY.md`, navigation and notes started traveling with Git, those legacy entries still hid the contract files: `ai-workflow init` and `init --upgrade` only appended missing entries and treated an existing `.ai-workflow/` as already covering `.ai-workflow/plans/`, so an adopted project kept the old exclusions and its contract files stayed untracked.

## Decision

- `initializeProject` and `upgradeProject` reconcile the project `.gitignore` through one helper, `reconcileIgnoreFile` in `src/sync/index.ts` (imported by `src/install/index.ts`): the exact legacy lines `.ai-workflow`, `.ai-workflow/` and `MEMORY.md` are removed, then `.ai-workflow/plans/` and `.worktrees/` are appended only when absent.
- Every other line, `*.log` included, is preserved byte for byte; `*.log` and similar entries are generic ignores that ai-workflow does not own.
- The file is written only when the reconciled content differs, so a repeat upgrade reports an empty `created`, and a failed run still restores the original `.gitignore` bytes through the existing transaction recovery.
- `tests/integration/project-cli.test.ts` and `tests/integration/project-upgrade.test.ts` cover the migration and `README.md` states it; `.worktrees/` stays ignored because [the ignored-state sharing record](./2026-09-14-share-ignored-state-into-worktree.md) requires it.

## Alternatives considered

- **Rewrite the `.gitignore` from a managed template.** Declined: it would clobber unrelated user and tool lines that ai-workflow does not own.
- **Keep the legacy entries and leave migration to the user.** Declined: `MEMORY.md` and the rest of `.ai-workflow/` are contract files that must travel with Git, and the CLI knows the exact old output it can repair.
- **Also remove `*.log`.** Declined: `*.log` is a common pre-existing ignore unrelated to ai-workflow, so removing it would un-ignore logs the user intended to hide.
- **Match broader legacy variants such as `/.ai-workflow/` or `.ai-workflow/*`.** Declined: only the exact lines that ai-workflow and the shared templates wrote are known output, and broader matching risks deleting user intent.

## Consequences

- Every project initialized or upgraded from now on keeps only `.ai-workflow/plans/` and `.worktrees/` ignored, so `MEMORY.md`, the project contract, navigation and notes arrive in coding worktrees through Git.
- An adopted project is migrated by one `ai-workflow init <project> --upgrade`; a fresh `init` over a pre-existing legacy `.gitignore` migrates it in the same run, while plain `init` on an adopted project still stops on conflicts by design.
- No active note is superseded: [the worktree policy record](./2026-09-14-project-local-worktree-policy.md) and [the ignored-state sharing record](./2026-09-14-share-ignored-state-into-worktree.md) remain current.
