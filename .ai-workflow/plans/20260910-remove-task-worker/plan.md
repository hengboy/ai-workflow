---
plan_id: "20260910-remove-task-worker-v2"
status: frozen
created_at: "2026-09-10"
supersedes: "20260910-remove-task-worker"
requirement_count: "4"
acceptance_criteria_count: "8"
digest: ""
---

# Implementation Plan

## Requirement coverage
| Requirement | Acceptance criteria | Steps | Validation |
| --- | --- | --- | --- |
| REQ-001 | AC-001, AC-008 | 3, 4 | generated types, tests, build |
| REQ-002 | AC-002, AC-003 | 1, 2 | dispatch matrix tests |
| REQ-003 | AC-005 | 1, 2 | coding/integration tests |
| REQ-004 | AC-004 | 2 | routing tests |

## Implementation sequence
### Step 1: Rewrite direct orchestration contracts
- Responsible role: `backend`
- Read scope: `templates/skills/coding/SKILL.md`, `templates/skills/planning/SKILL.md`, `templates/skills/plan-to-tasks/SKILL.md`, `templates/agents/documentation-maintainer.md`, `AGENTS.md`, `CLAUDE.md`, corresponding templates and behavior tests.
- Write scope: those listed guidance files and their tests.
- Changes: primary orchestrator owns scheduling; specialists return requests/evidence and never dispatch children. Preserve TDD: Test RED first, implementation GREEN, complete Test validation, parallel one-time reviews, user repair choice.
- Validation: `pnpm vitest run tests/behavior/coding-v2-content.test.ts tests/behavior/planning-content.test.ts tests/integration/global-agent-guidance.test.ts`.
- Dependencies: none
### Step 2: Implement routing and execution graph
- Responsible role: `backend`
- Read scope: `src/workflow/`, `src/runtime/`, `src/install/`, `src/profile/`, `tests/unit/workflow.test.ts`, workflow integration tests.
- Write scope: workflow/runtime routing and manifest sources plus routing/dispatch tests.
- Changes: remove coordinator nodes and fallback; implement the stated surface table, cross-stack dependency order, repair direct dispatch, and pre-execution diagnostics.
- Validation: targeted workflow tests, `pnpm typecheck`, `pnpm build`.
- Dependencies: Step 1
### Step 3: Remove role and migration artifacts
- Responsible role: `backend`
- Read scope: `templates/agents/task-worker.md`, `schemas/packet.schema.json`, `schemas/navigation.schema.json`, `schemas/profile.schema.json`, `src/install/index.ts`, `src/install/render.ts`, `src/profile/index.ts`, install/profile tests.
- Write scope: delete role template, update schemas/generated declarations and install/profile tests.
- Changes: remove enum/profile/render route; retain manifest-owned cleanup; reject legacy profile atomically.
- Validation: `pnpm types:generate`; focused install/profile tests including owned/unowned fixtures.
- Dependencies: Step 2
### Step 4: Update project metadata and complete verification
- Responsible role: `documentation-maintainer`
- Read scope: `MEMORY.md`, `.ai-workflow/index/navigation.json`, `.ai-workflow/index/navigation.md`, all changed paths.
- Write scope: only required memory/navigation metadata and generated navigation markdown.
- Changes: record direct orchestration ownership and removed role where architecture metadata requires it.
- Validation: `pnpm check`; scan production source/templates/tests for active role references.
- Dependencies: Step 3

## Integration and compatibility
Schema/templates are authoritative; generated declarations follow them. The primary orchestrator is the only dispatcher. Git Operator remains the only Git actor. Upgrade cleanup is manifest-owned only; legacy profile rejection precedes mutation.

## Rollback
Revert steps in reverse order, restore schemas/templates/guidance, regenerate declarations, reinstall the previous version, verify restoration of owned files and rerun focused tests. Stop before mutation if rollback validation fails.

## Risks
| Risk | Mitigation | Evidence |
| --- | --- | --- |
| stale generated route | regenerate and build | `pnpm types:generate`, `pnpm build` |
| hidden nested delegation | matrix and guidance tests | focused Vitest |
| unsafe cleanup | ownership fixtures | install tests |
| cross-stack regression | explicit backend/frontend route test | workflow tests |
