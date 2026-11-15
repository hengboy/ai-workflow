# Agent Note: Plan write-scope completeness

Status: implemented

English | [中文](2026-11-16-plan-write-scope-completeness.zh.md)

## Problem

Frozen plans sometimes omit files that implementation must create or modify, especially tests, fixtures, export barrels, registration wiring, tracked generated outputs, documentation and note sides. Execution then either stops on a blocked support request or writes outside the frozen scope, so the delivered path set no longer matches the plan.

## Decision

Planning freezes each step's write scope as a complete exact file inventory derived from repository evidence. The inventory names every created, modified, deleted or renamed path, including behavior tests and fixtures, existing tests whose expectations change, export barrels, module indexes, route or registration wiring, schemas, migrations, tracked generated outputs, documentation, navigation, `MEMORY.md`, each affected note triplet side, both rename endpoints and every deletion. Directories, wildcards, globs, placeholders and vague "related files" entries are not write scopes. Each existing path is resolved through the locator or File Explorer, and each new path is marked as new.

Plan-to-tasks derives each task's `write_scope` only from the frozen inventory. The union of task write scopes equals the covered plan-step inventory; a path absent from the plan, or an exact path widened to a directory, is a frozen-plan defect reported as a bounded support request instead of being added silently.

Before the first edit, Coding compares every intended path with the frozen scope. A required path outside it stops before the edit with a bounded support request naming the path, the behavior that needs it and the plan gap; it is never created, modified or replaced by a broader directory.

## Alternatives considered

- Auto-add a missing path during task splitting or coding. Declined: the frozen plan would no longer be the complete write authority and plans would stay misleading.
- Allow a directory write scope when the exact files are unknown. Declined: a directory authorizes every file under it and recreates the original scope overflow.
- Rely on a post-delivery diff check. Declined: the violation would already have landed, and the review would have to reconstruct the intended scope.

## Consequences

Planning takes one extra audit before the confirmation preview and freeze. Plan-to-tasks and coding stop earlier when a plan is incomplete rather than discovering the gap late. The frozen plan and task scopes become reliable for execution, review and commit boundaries. A plan that omits a required path needs a bounded planning repair before implementation; execution never invents the missing authorization.
