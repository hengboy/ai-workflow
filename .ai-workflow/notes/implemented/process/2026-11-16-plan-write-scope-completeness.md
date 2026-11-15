# Agent Note: Plan write-scope completeness

Status: implemented

English | [中文](2026-11-16-plan-write-scope-completeness.zh.md)

## Problem

Frozen plans sometimes omit files that implementation must create or modify, especially tests, fixtures, export barrels, registration wiring, tracked generated outputs, documentation and note sides. Execution then either stops on a blocked support request or writes outside the frozen scope, so the delivered path set no longer matches the plan.

## Decision

Planning freezes each step's write scope as a complete exact file inventory derived from repository evidence. The inventory names every created, modified, deleted or renamed path, including behavior tests and fixtures, existing tests whose expectations change, export barrels, module indexes, route or registration wiring, schemas, migrations, tracked generated outputs, documentation, navigation, `MEMORY.md`, each affected note triplet side, both rename endpoints and every deletion. Directories, wildcards, globs, placeholders and vague "related files" entries are not write scopes. Each existing path is resolved through the locator or File Explorer, and each new path is marked as new.

Plan-to-tasks derives each task's `write_scope` only from the frozen inventory. The union of task write scopes equals the covered plan-step inventory; no task adds a path the plan does not declare, and an exact plan path is never widened to a directory.

Before the first edit, Coding classifies every path outside the frozen scope. A supporting path is an exact path within the same repository and frozen-AC boundary that adds no user-visible behavior, public interface, configuration or dependency, schema or migration, cross-module or cross-stack contract, or security/privacy boundary; examples are a behavior test, fixture, snapshot, barrel or registry entry, tracked generated output, documentation, navigation, `MEMORY.md` or note triplet side. The primary verifies and authorizes it in-run, records it in the task commit body and final report, and includes it in the review range without separate approval. A material path — production source, public interface, configuration or dependency, schema or migration, or cross-module or cross-stack behavior — gets one bounded user decision; changed REQ/AC or public contract requires a new plan ID. An amendment is always one exact path; repeated or material amendments indicate a defective plan and require planning repair.

## Alternatives considered

- Auto-add a missing path during task splitting or coding. Declined: the frozen plan would no longer be the complete write authority and plans would stay misleading.
- Allow a directory write scope when the exact files are unknown. Declined: a directory authorizes every file under it and recreates the original scope overflow.
- Block every missing path until the plan is repaired. Declined: one incidental supporting path would stall the whole plan and force avoidable replanning.
- Rely on a post-delivery diff check. Declined: the violation would already have landed, and the review would have to reconstruct the intended scope.

## Consequences

Planning still takes one extra audit before the confirmation preview and freeze. A single omitted supporting path no longer blocks the whole plan: the primary records an exact in-run amendment and continues, with the amendment visible in the commit, final report and review. Material scope changes still require a bounded decision or planning repair, and repeated amendments signal that the plan was incomplete.
