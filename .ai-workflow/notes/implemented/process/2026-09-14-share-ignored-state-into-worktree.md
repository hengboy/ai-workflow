# Agent Note: Share ignored state into the coding worktree

Status: implemented

English | [中文](2026-09-14-share-ignored-state-into-worktree.zh.md)

## Problem

The mandatory coding worktree is created through `git worktree add`, which checks out only tracked content. As a result `MEMORY.md`, `.ai-workflow/` and every other gitignored path are absent from the worktree, yet coding must read the frozen plan, `MEMORY.md`, navigation and notes, and must run tests that need `node_modules`. The earlier rule named only `MEMORY.md` and `.ai-workflow`, which was incomplete: the required ignored set also includes every plan document under `.ai-workflow/plans/`, dependencies and build outputs, and it grows with each project.

## Decision

Immediately after `git worktree add`, Git Operator materializes the project's entire gitignore state into the coding worktree. At the project root it enumerates that state with `git ls-files --others --ignored --exclude-standard --directory`, excludes the `.worktrees/` container that holds the worktrees themselves, and creates a symbolic link for each file entry. For each directory entry it creates a real directory in the worktree and symlinks only that directory's direct children, because an ignore pattern with a trailing slash such as `.ai-workflow/` matches a real directory and not a directory symlink, which would otherwise expose the link as untracked. There is no hard-coded path list, so plan documents, navigation, notes, dependencies and generated outputs are all covered.

Ignored state stays single-sourced at the project root: the symlinks point back to the root files, so artifacts written from the worktree such as notes and screenshots land at the root, and deleting the worktree deletes only the links. The worktree remains the target for tracked source edits and per-step commits. This rule is still current and is declared together by the `coding` skill, the `git-operator` role, the project contract and `MEMORY.md`.

## Alternatives considered

- **Hard-code the required paths.** Rejected: it would miss plan documents, notes, dependencies and build outputs and drift as the workflow grows.
- **Copy the ignored state into the worktree.** Rejected: it copies large trees, goes stale quickly, and loses worktree-written artifacts such as notes and screenshots when the worktree is deleted.
- **Skip materialization and always read through absolute paths from the project root.** Rejected: relative reads and tools that use the worktree as cwd still cannot see ignored paths, and it does not provide `node_modules`.

## Consequences

- Coding can read the frozen plan, `MEMORY.md`, navigation, notes, dependencies and build outputs through the worktree with no hard-coded exclusion list.
- Ignored state is shared, not copied: running an install or build inside the worktree writes back to the shared root paths, so dependency changes are handled as an explicit isolated step rather than by copying.
- `git status` inside the worktree stays clean because the linked entries match the project `.gitignore`.
- `.worktrees/` must stay in the project `.gitignore` and is the only entry excluded from materialization.
- The `coding` skill, the `git-operator` role, the project contract and the root `MEMORY.md` declare the same rule, extending the worktree policy.
