---
name: coding
description: Implements an approved task with test-driven development and bounded scope.
---

# Coding

Implement one approved task exclusively through test-driven development. Every
production change must be driven by a behavior test in a red -> green loop.

## Preconditions

- Read `MEMORY.md`, both navigation index files, and the frozen `spec.md` and `plan.md`.
- A plan may be implemented either as a whole or through its split tasks. When a
  `tasks/<taskId>.md` is assigned, use only that task's exact read and write
  scopes and declared commands. When no task files exist, use the frozen plan's
  explicit scope and acceptance criteria as the implementation boundary.
- A missing or empty navigation index is normal for a new project. A locate
  `missing_index` or feature `miss` result must not block implementation when
  the plan (or an authorized bounded discovery result) identifies the paths and
  symbols. Request File Explorer only when the implementation boundary remains
  unclear.
- Before implementation, confirm the target is a Git repository, record the current branch, and create one temporary worktree under `<project>/.worktrees/<name>`; perform all implementation and checks there.
- Create a Todo list before editing and keep it current. Each step must state its
  scope, acceptance evidence and commit point.
- Before writing a test, state the public interface and observable boundary it
  will exercise. If that boundary is unclear, stop and request clarification.

## Pre-Implementation Todo

Before any implementation edit, create a Todo list. Mark exactly one step
`in_progress`; each step must include its scope, acceptance standard and commit
point. Update it immediately when a step is verified and committed, before
starting the next step.

## Step Execution, Verification and Commit

Treat every Todo step as an independent red -> green, verification and commit
unit. After its checks pass, self-check the behavior, boundaries and scope once,
then use the `git-commit` skill immediately. Commit only that step's changes and
record its hash. Do not combine steps or proceed to the next step before this
commit succeeds.

## Procedure

1. Choose one behavior or boundary from one acceptance criterion.
2. Write one behavior-level test against the public interface, then run it and
   confirm it fails for the expected reason. A test that already passes is not
   evidence; investigate before continuing.
3. Write only the smallest production change that makes that test pass, and run
   the same test again.
4. Repeat steps 1-3 vertically for every behavior. Do not write all tests first
   and implement them later.
5. Only after all slices pass, perform a small refactor when it removes
   duplication created by this work; rerun affected tests after refactoring.
6. Run the task's complete validation commands and report every changed path and
   check result.

After all steps, merge the temporary branch back, rerun affected checks, and
remove only the owned worktree and branch. Never stage unrelated user changes.

## Test Boundaries

Tests must use public interfaces and observable behavior. Before writing each
test, identify the interface and boundary it exercises; stop and request
clarification if that boundary is unclear.

## Test quality

- Use independent expected values and preserve regression tests for defects.
- Name tests as behavioral specifications. Test stable public boundaries only;
  never test private methods, internal collaborators or implementation shape.
- Do not weaken assertions, suppress failures, or add unrelated compatibility layers.
- Run the narrowest relevant test first, then the required typecheck, lint, build or integration checks.

For a defect, first add a stable public-interface regression test that reproduces
the defect and verify it fails. Keep that test after the direct fix.

## Anti-Patterns to Avoid

Avoid same-algorithm expectations, mocks of internal collaborators, private
method tests, and tests that merely assert constants or implementation details.
Do not write all tests first and implement them later.

## Red -> Green Loop

For each behavior, write one failing test, confirm the expected failure, add the
smallest implementation that makes it pass, and rerun it before choosing the
next behavior. A test that passes initially is not coverage evidence.

## Verification and Commit

Run the narrowest relevant test after each slice, then the declared typecheck,
lint, build or integration checks. After each step, self-check once and commit
only that step with `git-commit`; after all steps merge the temporary branch,
rerun affected checks, and clean up only the owned worktree and branch.

Do not generate workflow manifests or run records. Do not expand scope, search outside the packet, publish, or edit frozen planning artifacts. Git operations are allowed only through Git Operator or the prescribed `git-commit` step.

## Completion checklist

- Every assigned REQ/AC has implementation and test evidence from a completed
  red -> green slice.
- Every slice was verified, self-checked once, and committed before the next
  slice began; commits contain only that slice's scoped changes.
- Negative cases and failure output are reported truthfully.
- Screenshots remain under the plan's `screenshot/` directory.
- Return `done` only when all scoped checks pass; otherwise return `blocked` or `failed` with support requests.
