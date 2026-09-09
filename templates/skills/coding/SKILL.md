---
name: coding
description: Implements an approved task with test-driven development and bounded scope.
---

# Coding

Implement one approved task using a red-green test-driven loop.

## Preconditions

- Read `MEMORY.md`, both navigation index files, the frozen `spec.md`, `plan.md` and the assigned task file.
- Use only the task's exact read and write scopes and declared commands.
- If a path or requirement is unclear, stop and request File Explorer support.
- Before implementation, confirm the target is a Git repository, record the current branch, and create one temporary worktree under `<project>/.worktrees/<name>`; perform all implementation and checks there.
- Create a Todo list before editing and keep it current. Treat each task step as an independent red-green, verification and commit unit.

## Procedure

1. Write one behavior-level regression test and confirm it fails for the expected reason.
2. Make the smallest implementation that makes that test pass.
3. Repeat for each acceptance criterion, then run the task's complete validation commands.
4. Preserve existing behavior, avoid unrelated cleanup and report every changed path and check result.

After each step, run the narrowest relevant checks, inspect the diff once, and commit that step with the `git-commit` skill. After all steps, merge the temporary branch back, rerun affected checks, and remove only the owned worktree and branch. Never stage unrelated user changes.

## Test quality

- Test public behavior rather than private implementation details.
- Use independent expected values and preserve regression tests for defects.
- Do not weaken assertions, suppress failures, or add unrelated compatibility layers.
- Run the narrowest relevant test first, then the required typecheck, lint, build or integration checks.

Do not generate workflow manifests or run records. Do not expand scope, search outside the packet, publish, or edit frozen planning artifacts. Git operations are allowed only through Git Operator or the prescribed `git-commit` step.

## Completion checklist

- Every assigned REQ/AC has implementation and test evidence.
- Negative cases and failure output are reported truthfully.
- Screenshots remain under the plan's `screenshot/` directory.
- Return `done` only when all scoped checks pass; otherwise return `blocked` or `failed` with support requests.
