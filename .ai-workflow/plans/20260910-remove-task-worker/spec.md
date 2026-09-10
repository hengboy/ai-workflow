---
plan_id: "20260910-remove-task-worker-v2"
status: frozen
created_at: "2026-09-10"
supersedes: "20260910-remove-task-worker"
requirement_count: "4"
acceptance_criteria_count: "8"
digest: ""
---

# Specification

## Goal
Remove `task-worker` and make the primary orchestrator directly dispatch every native specialist while preserving current execution guarantees.

## Non-goals
- Do not change specialist permissions, REQ/AC semantics, dependency ordering, worktree isolation, or review counts.
- Do not retain a compatibility alias or silently accept unknown roles.

## Scenarios
### Primary scenario
For split and unsplit coding, the primary orchestrator directly dispatches Git Operator setup, File Explorer, the implementation role, Test, both reviews, repair if selected, and Git Operator finalization in dependency order.

### Direct-dispatch matrix
| Scenario | Directly dispatched roles | Forbidden nested dispatch |
| --- | --- | --- |
| split task | Git Operator, File Explorer, Backend/Frontend/Researcher/Documentation Maintainer, Test, Reviews, Git Operator | Task Worker |
| unsplit plan | same roles per plan step | Task Worker |
| implementation repair | original implementation role, Test | Task Worker |
| planning commit | Git Operator | Planning -> Git Operator |
| task-file commit | Git Operator | Plan-to-tasks -> Git Operator |
| documentation commit | Git Operator | Documentation Maintainer -> Git Operator |

## Requirements
### REQ-001: Remove role surface
No installed agent, schema, generated type, workflow node, profile entry, or route may expose `task-worker`.
### REQ-002: Flatten orchestration
The primary orchestrator directly schedules all roles in the matrix, including repair and finalization.
### REQ-003: Preserve guarantees
TDD red/green order, exact scopes, dependencies, one repair/retest, exactly one Spec Review and Standards Review, and Git Operator-only Git effects remain enforced.
### REQ-004: Validate routing before execution
Supported surfaces route directly: backend->backend, frontend->frontend, research->researcher, documentation->documentation-maintainer, cross-stack->backend then frontend in dependency order. Empty/unknown surfaces fail before execution with a diagnostic naming `surface` and allowed values.

## Acceptance criteria
### AC-001: No active role
- Given source templates and schemas
- When rendering and generating types
- Then no active `task-worker` artifact or enum exists.
### AC-002: Direct task dispatch
- Given split or unsplit work
- When Coding executes
- Then the matrix roles are dispatched by the primary orchestrator with no coordinator node.
### AC-003: Direct commit dispatch
- Given planning, task generation, or documentation completion
- When a commit is needed
- Then the primary orchestrator directly dispatches Git Operator.
### AC-004: Surface routing and rejection
- Given each supported, empty, or unknown surface
- When workflow generation runs
- Then supported routes match the table and invalid values fail before execution.
### AC-005: Guarantees preserved
- Given failing tests or pending reviews
- When repair or merge is attempted
- Then the one-repair, dual-review, scope, and Git gates block invalid progression.
### AC-006: Owned legacy cleanup
- Given an owned old agent file and an unowned same-named file
- When upgrading
- Then only the owned file is removed.
### AC-007: Legacy profile atomic rejection
- Given a profile containing `task-worker`
- When loading/installing
- Then a migration error names the role and no files are partially mutated.
### AC-008: Built artifacts agree
- Given updated source
- When type generation, tests, lint, typecheck, and build run
- Then no active route or stale assertion remains.

## Error boundaries and counterexamples
- Empty and unknown `surface` values are invalid before execution.
- An unowned legacy file must not be deleted.
- A legacy profile must not be silently accepted or partially installed.

## Verification layers and RED criteria
| Requirement | Acceptance criteria | Layer | RED evidence before implementation |
| --- | --- | --- | --- |
| REQ-001 | AC-001, AC-008 | behavior/integration | role-output, schema and stale-reference tests fail |
| REQ-002 | AC-002, AC-003 | behavior | dispatch matrix tests fail on coordinator/nested routes |
| REQ-003 | AC-005 | behavior/integration | gate and TDD contract tests fail if ordering changes |
| REQ-004 | AC-004 | unit/behavior | routing tests fail on fallback/invalid surface |

## Compatibility and rollback
Manifest-owned legacy files are removed on upgrade. Legacy profiles require migration and fail atomically. Rollback restores the previous commit, reinstalls it, verifies owned legacy files return, and reruns focused tests.
