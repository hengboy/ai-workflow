---
plan_id: "20260910-project-navigation-discovery"
status: frozen
created_at: "2026-09-10"
supersedes: null
requirement_count: 6
acceptance_criteria_count: 13
digest: "sha256:acff2d9d03de2fee8fcde91e6ad449a58f947ee39d491783909792740a142968"
---

# Implementation Plan

## Approval and execution contract

Implements the approved spec with six requirements and thirteen acceptance criteria. Exactly one planning Spec Review ran; its findings were repaired and the user approved the complete revised inventory. Do not repeat that planning review. Implementation has its own required final Spec Review and Standards Review.

This is an unsplit plan. Coding delegates one complete unit per step in dependency order, using one project-local temporary worktree. Backend edits product files, Test edits explicitly scoped tests and runs named checks, Documentation Maintainer edits scoped documentation, and Git Operator owns all Git operations and per-step commits. The orchestrator continues until complete or blocked. No tasks, workflow manifests or run records are created by this plan.

## Context and scope conventions

Repository: `/Users/yuqiyu/AiHistorys/ai-workflow`. All paths below are relative to that root or its authorized implementation worktree.

Fixed read context for every step: `MEMORY.md`, `.ai-workflow/index/navigation.json`, `.ai-workflow/index/navigation.md`, and this plan's `spec.md` and `plan.md`.

Bounded File Explorer discovery previously established the exact paths below because the navigation feature list was empty. The empty feature list is not an implementation blocker. Each step may read its named write targets when they exist, its listed additional read files and prior-step output files explicitly named in its dependencies. No broad repository search is authorized.

Existing evidence: `src/install/index.ts` copies templates and records their hashes; update can replace digest-matching navigation with empty templates. `src/context/validate.ts` hardcodes TypeScript semantic parsing across validation and refresh. `src/context/navigation.ts` renders JSON to Markdown. The existing yaml dependency and schema validator support configuration parsing; no new dependency is assumed.

## Requirement coverage

Test commands referenced here are spelled out in their implementation steps. Backend owns implementation for steps 1-4; Test owns all behavior evidence, including step 5.

| Requirement | AC | Step | Fixture/state and observable assertion | RED test / command |
| --- | --- | --- | --- | --- |
| REQ-001 | AC-001 | 1, 4 | Source plus excluded dirs/external symlink; inventory contains only allowed local files | navigation-discovery.test.ts / C1 |
| REQ-001 | AC-002 | 4 | Empty repository; successful empty index and matching Markdown | navigation-init.test.ts / C4; compatibility control |
| REQ-002 | AC-003 | 2, 3, 5 | TS/JS exports and tests; populated entries and verified symbols | navigation-adapters.test.ts / C2; C5 |
| REQ-002 | AC-004 | 2, 5 | Maven, Gradle Groovy/Kotlin and two Boot classes; package names and all Boot entries | navigation-adapters.test.ts / C2; C5 |
| REQ-003 | AC-005 | 2, 3 | Java ordinary and annotated sources plus tests; complete exact-file coverage | navigation-adapters.test.ts / C2 |
| REQ-003 | AC-006 | 2 | Annotated and plain same-package classes plus comment decoy; correct entries/related files | navigation-adapters.test.ts / C2 |
| REQ-003 | AC-007 | 2 | Unsupported Java syntax; retained file, empty semantics and path/code/message diagnostic | navigation-adapters.test.ts / C2 |
| REQ-004 | AC-008 | 3, 5 | Java/file-only unknown language, TS semantic drift and mixed modules; lifecycle success and deliberate drift failure | navigation-semantic.test.ts, navigation-refresh-cli.test.ts / C3; C5 |
| REQ-004 | AC-009 | 3 | Shuffled candidate arrays; identical JSON bytes and exact renderNavigation output | navigation-builder.test.ts / C3 |
| REQ-005 | AC-010 | 4 | Existing targets and injected publication error; no extra files, original gitignore restored | gates.test.ts, navigation-init.test.ts / C4 |
| REQ-005 | AC-011 | 4, 5 | New/old/mismatching manifest records and missing manifest; actual digests, navigation skipped or missing-manifest error | project-cli.test.ts, navigation-init.test.ts / C4; C5 |
| REQ-006 | AC-012 | 1, 3, 5 | Multi-source/multi-language declarations; one root per module with bound explicit feature | navigation-project-config.test.ts / C1; C5 |
| REQ-006 | AC-013 | 1, 4, 5 | Absent/partial config vs invalid YAML, paths and duplicate ownership; supplement or prewrite rejection | navigation-project-config.test.ts / C1; navigation-init.test.ts / C4 |

## Implementation sequence

### Step 1: Repository facts and explicit configuration

- Responsible roles: Backend for product/schema, Test for tests, Git Operator for commit.
- Additional read scope: `src/utils/fs.ts`, `src/utils/schema.ts`, `schemas/navigation.schema.json`, `package.json`, `tests/helpers.ts`.
- Product write scope: `src/context/discovery/types.ts`, `src/context/discovery/scanner.ts`, `src/context/discovery/project-config.ts`, `schemas/project.schema.json`, `src/generated/project.schema.d.ts`.
- Test write scope: `tests/unit/navigation-discovery.test.ts`, `tests/unit/navigation-project-config.test.ts`.
- Changes: define facts, candidate and internal diagnostic types; deterministic traversal and exclusions; explicitly load optional project.yml; validate schema and real paths. Implement the exact configuration cardinality, module-relative/project-relative path rules, overlaps and ownership contract from spec. No silent caps or network reads. Test trees are created in test temporary directories.
- Validation C1: `pnpm exec vitest run tests/unit/navigation-discovery.test.ts tests/unit/navigation-project-config.test.ts`. Detects missing filtering, incorrect relative paths and ignored invalid declarations. RED first, then GREEN.
- Generate only new schema types via `pnpm exec json2ts -i schemas/project.schema.json -o src/generated/project.schema.d.ts --bannerComment '/* Generated from authoritative JSON Schemas. Do not edit. */'`; avoid unrelated generated-file churn. `pnpm typecheck` checks candidate/config interfaces.
- Dependencies: none.

### Step 2: TS/JS and Java structural adapters

- Responsible roles: Backend, Test, Git Operator.
- Additional read scope: `src/context/validate.ts`, `src/context/navigation.ts`, `package.json`, `tests/helpers.ts`, step 1's `types.ts`, `scanner.ts`, `project-config.ts`.
- Product write scope: `src/context/discovery/adapters.ts`, `src/context/discovery/typescript.ts`, `src/context/discovery/java.ts`.
- Test write scope: `tests/unit/navigation-adapters.test.ts`.
- Changes: adapter registry selects appropriate analysis from facts. TS/JS reuse compiler parsing; Java recognizes conventional roots, package and supported annotation tokens without mistaking comments/strings for declarations. Do not execute Maven or Gradle. Java returns file-only candidates, empty semantic fields, and structured diagnostics when classification fails. No full Java AST dependency is required. Diagnostics remain internal. Define observable classification exactly as AC-006, including multiple Boot entries.
- Validation C2: `pnpm exec vitest run tests/unit/navigation-adapters.test.ts`. Proves TS/JS exports, Maven/Gradle Groovy/Kotlin roots, annotation classification, comment counterexample, multi-Boot case and structural fallback. `pnpm typecheck` checks adapter contracts.
- Dependencies: step 1.

### Step 3: Builder and lifecycle-compatible verification

- Responsible roles: Backend, Test, Git Operator.
- Additional read scope: `src/context/locate.ts`, `src/context/paths.ts`, `schemas/navigation.schema.json`, `schemas/navigation.candidate.schema.json`, `src/utils/schema.ts`, `tests/helpers.ts`, step 1-2's six discovery product files.
- Product write scope: `src/context/discovery/builder.ts`, `src/context/validate.ts`, `src/context/navigation.ts`.
- Test write scope: `tests/unit/navigation-builder.test.ts`, `tests/unit/navigation-semantic.test.ts`, `tests/integration/navigation-refresh-cli.test.ts`.
- Changes: configured module ID/path maps to one root; explicit feature ownership precedes discovery. Reserve explicit IDs and deterministically derive generated IDs. Expand file sets into entries/related_files/tests and exact covered read scopes. Keep source/test ownership within module boundaries. Generic discovered/configured structure uses file capability; TS/JS semantic extraction uses exported-symbol capability. Mixed modules route by file language; legacy mixed roots without the new capability retain their behavior.
- Validation changes must explicitly separate structural existence/coverage from semantic verification. File-only Java and configured unknown-language roots pass; unsupported semantic languages fail. Deleted entries and newly unclassified structural source files fail. TypeScript symbols and relations remain checked.
- Authorized refresh reuses appropriate adapter analysis for existing features and preserves structural related files and tests. Do not introduce a new candidate protocol, broaden authorized roots or reuse refresh as the initialization entry point. Existing directory-entry compatibility must remain even though generated scopes use exact files.
- Canonicalize root/feature IDs, path sets, symbols, relations and diagnostics as AC-009. Render Markdown once from JSON; do not maintain a second template-derived representation.
- Validation C3: `pnpm exec vitest run tests/unit/navigation-builder.test.ts tests/unit/navigation-semantic.test.ts tests/integration/navigation-refresh-cli.test.ts`. RED demonstrates unsupported structural verification/coverage loss before implementation; shuffled candidates prove canonical output. `pnpm typecheck` checks integration of parser dispatch.
- Dependencies: steps 1-2.

### Step 4: Transactional initialization and update protection

- Responsible roles: Backend, Test, Git Operator.
- Additional read scope: `src/install/render.ts`, `src/utils/fs.ts`, `src/utils/hash.ts`, `src/cli.ts`, `tests/helpers.ts`, `templates/project/navigation.json`, `templates/project/navigation.md`, step 1-3's seven discovery product files and `src/context/validate.ts`, `src/context/navigation.ts`.
- Product write scope: `src/install/index.ts`.
- Test write scope: `tests/integration/project-cli.test.ts`, `tests/behavior/gates.test.ts`, `tests/integration/navigation-init.test.ts`.
- Changes: preflight managed targets, collect facts/config/candidates and validate generated navigation before publication. Preserve public init arguments and returned created-path list. Keep discovery/read-only candidate validation independent of already-installed MEMORY/navigation files; use the step 3 validation helpers on the proposed model. Do not call full on-disk validateContext before required documents exist.
- Publish generated documents and actual-byte manifest with scoped rollback on ordinary write errors. Record the original gitignore, delete only invocation-created files/directories and restore original bytes on failure. No whole-project directory replacement, crash recovery machinery or new hashes beyond existing ownership digests.
- Update skips navigation.json/md unconditionally, whether old records describe empty templates, current generated bytes or different bytes. Other template ownership behavior is unchanged. Missing manifest errors; missing navigation is skipped. Do not own project.yml.
- Validation C4: `pnpm exec vitest run tests/integration/project-cli.test.ts tests/behavior/gates.test.ts tests/integration/navigation-init.test.ts`. Cover conflict preflight, actual hashes, every navigation ownership state, invalid-config prewrite rejection, and injected failures after document/gitignore/manifest write boundaries. These tests distinguish real rollback from only preflight checks.
- Dependencies: steps 1-3.

### Step 5: End-to-end compatibility evidence

- Responsible roles: Test for scoped behavior tests and commands, Git Operator for commit. Product fixes return to the owning step with its scope.
- Additional read scope: `src/cli.ts`, `src/install/index.ts`, `src/context/validate.ts`, `src/context/locate.ts`, `src/context/navigation.ts`, `tests/helpers.ts`, step 1-3's seven discovery product files.
- Test write scope: `tests/integration/navigation-init.test.ts`, `tests/integration/navigation-validate-cli.test.ts`, `tests/integration/navigation-locate-cli.test.ts`, `tests/integration/navigation-project-contract.test.ts`.
- Changes: create temporary empty, TS/JS, Maven, Gradle, configured generic and mixed frontend/backend projects. Exercise init, validation, verified feature lookup, authorized refresh and template update. Assert user configuration bytes and generated navigation survive template update. Cover multiple source roots and partial declarations, file-only drift failures and legacy mixed/directory behavior.
- Validation C5: `pnpm exec vitest run tests/integration/navigation-init.test.ts tests/integration/navigation-validate-cli.test.ts tests/integration/navigation-locate-cli.test.ts tests/integration/navigation-project-contract.test.ts tests/integration/navigation-refresh-cli.test.ts tests/unit/navigation-contract.test.ts tests/unit/navigation-fallback.test.ts tests/integration/navigation-fallback-cli.test.ts tests/install/install.test.ts`. This is the cross-component regression boundary: exact scopes, fallback behavior, refresh authorization, ownership and host-install isolation. Run once after integrated changes; repeat only affected failures after fixes.
- Run `pnpm typecheck` and `pnpm build` to detect type/package compilation errors introduced across modules. No unconditional full-suite command is required.
- Dependencies: step 4 and its exact outputs.

### Step 6: Documentation and repository navigation

- Responsible roles: Documentation Maintainer for four documentation files, Test for authorized checks, Git Operator for commits. Backend does not edit these files.
- Read/write scope: `README.md`, `MEMORY.md`, `.ai-workflow/index/navigation.json`, `.ai-workflow/index/navigation.md`.
- Additional read scope: `schemas/project.schema.json`, `src/install/index.ts`, `src/context/navigation.ts`, `src/context/validate.ts`, step 1-3's seven discovery product files, `tests/integration/navigation-init.test.ts`.
- Changes: document project.yml, TS/JS and Java capability limits, fallback, exclusions, init conflicts, ordinary rollback, and navigation-skipping update behavior. Register new discovery ownership/public entry points and regenerate Markdown from authoritative JSON.
- Maintenance timing: perform the relevant part of this documentation work immediately with each preceding step that changes architecture/public symbols/workflow behavior, before its commit. Step 6 finalizes and verifies the accumulated documentation; it does not defer mandatory index maintenance until the end.
- Validation C6: `pnpm exec tsx src/cli.ts context validate --project . --all`. It detects stale repository navigation after adding public symbols and paths. Use exact feature locate verification for each newly indexed feature ID chosen during maintenance. Review README examples against AC-012/013 fixtures; do not mutate user configuration to test examples.
- Dependencies: steps 1-5; incremental maintenance accompanies each producing step.

## Integration and compatibility

- Preserve navigation v1 and its existing directory-entry compatibility. Generated lists use exact files, and read_scope covers the generated feature paths under existing validation rules; do not insert unrelated fixed agent context into feature read_scope.
- `file` is a capability carried in existing entry_kinds, not a schema confidence extension. Centralize language dispatch sufficiently for validate/refresh without introducing a general plugin framework or configurable provider system.
- Optional project.yml has its own schema, uses the existing yaml dependency, and is never a managed template. No root navigation-schema extension is planned.
- Keep existing update behavior for AGENTS.md, CLAUDE.md and MEMORY.md. Navigation update protection is the intentional compatibility change.
- A read or configuration failure is not Java syntax fallback. No source directory truncation may be reported as a complete index.
- If exact authorized files prove insufficient, stop with a bounded support request; do not silently expand scopes or modify frozen documents.

## Review and completion gates

After implementation and scoped checks, run exactly one implementation Spec Review against this pair and one Standards Review against MEMORY.md before merging the worktree. Present findings for user repair selection; unresolved findings block merge. Git Operator stages only authorized paths, uses git-message for each commit, preserves unrelated changes and performs no remote mutation. Documentation Maintainer passes its exact changed paths and validation evidence to Git Operator.

## Rollback

During init, ordinary failure restores only the invocation-owned changes as specified in AC-010. During development, Git Operator may perform authorized scoped reverts of implementation commits, preserving unrelated user work. Never remove project.yml or rewrite generated external-project navigation during rollback. Verify rollback with the original init/update compatibility fixtures, and retain the compatible CLI for repositories using the new structural capability.

## Risks

| Risk | Mitigation | Evidence |
| --- | --- | --- |
| Structural Java roots fail TypeScript-only validation | Explicit file/semantic capability dispatch across validate and refresh | C3, C5 |
| Multiple configured roots duplicate ownership | One navigation root per configured module; reject overlapping modules/features | C1, C5 |
| Annotation decoys imply false entry recognition | Token-aware structural classification and comment/string counterexamples | C2 |
| Template update destroys generated content | Unconditionally skip both navigation files | C4 |
| Ordinary publication failure leaves partial init | Preflight plus invocation-scoped rollback, including gitignore and manifest | C4 |
| Nondeterministic enumeration churns output | Canonical path/ID/semantic ordering | C3 |
| New discovery symbols stale repository navigation | Incremental documentation ownership and final validation | C6 |
