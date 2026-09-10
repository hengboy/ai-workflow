---
plan_id: "20260910-project-navigation-discovery"
status: frozen
created_at: "2026-09-10"
supersedes: null
requirement_count: 6
acceptance_criteria_count: 13
digest: "sha256:9c73d3a867799f028ab28b246399bb89843f9023904871c1b0415c41ff2f6a17"
---

# Specification

## Goal

Populate project navigation during `ai-workflow init` using repository evidence rather than empty templates. Support TypeScript/JavaScript and Spring Boot/Java first, including mixed repositories, through a common scanner, language adapters and navigation builder. Success means usable, deterministic navigation that remains valid through locate, refresh and template updates.

The user approved the complete scope and then approved the repairs from the single planning Spec Review. This document freezes that repaired scope.

## Non-goals

- No provider APIs, network discovery, project build execution or business-feature inference.
- No complete Java semantic graph, additional language semantic parsers or framework-wide dependency analysis.
- No new CLI flags, navigation confidence fields or refresh authorization protocol.
- No automatic creation or ownership of user project configuration.
- No merge into existing managed files during init, and no crash/power-loss recovery guarantee.

## Scenarios

### Primary scenario

A developer runs init on a nonempty repository without managed target files. The tool discovers code, builds navigation, validates it, and writes initialized documents and their actual-content manifest. Generated features can immediately be located with verification.

### Alternate scenarios

- An empty project initializes with an empty index.
- A frontend/backend repository produces separate discovered modules, or follows explicit module declarations.
- A valid partial configuration controls declared ownership while uncovered files are discovered.
- Unrecognized Java syntax retains file-level navigation without invented symbols.
- Existing managed targets, invalid configuration or unreadable inputs fail before publication. Ordinary publication failure restores prior state.

## Requirements

### REQ-001: Common repository discovery

Collect deterministic project-local file facts independently of language. Exclude generated/dependency directories, do not traverse project-external symlinks, and support empty projects. Do not silently truncate the scan.

### REQ-002: Pluggable language analysis

Use adapters that consume common facts and return candidates, not file writes. Initially support TS/JS and Java with Maven and Gradle, including `build.gradle.kts`. Additional adapters must not require changing initialization orchestration.

### REQ-003: Conservative Java navigation

Recognize Java packages and Spring classes at a structural level. Preserve unrecognized files without claiming semantic verification. Full Java AST analysis is not required for this release.

### REQ-004: Valid and deterministic navigation

Build version-1 navigation through one builder and render Markdown exclusively from JSON. Generated navigation must work with validate, verified locate and authorized refresh; preserve existing TypeScript semantic checks and legacy mixed-root behavior.

### REQ-005: Consistent initialization and ownership

Preflight conflicts and validation before publishing files. Recover from ordinary filesystem publication failures without losing preexisting content. Record actual written content digests. Template update must never replace navigation with empty templates.

### REQ-006: Explicit project configuration

Read optional user-owned `.ai-workflow/project.yml`. Valid declarations take priority; discovery supplements uncovered content. Invalid declarations fail before writes. Never generate, overwrite or add this configuration to the template ownership manifest.

## Acceptance criteria

### AC-001: Project-local bounded discovery for REQ-001

- Given source files alongside `.git`, `.ai-workflow`, `node_modules`, `vendor`, `target`, `build`, `dist`, `coverage`, `.next` and `.cache` directories and an external symlink,
- When discovery runs,
- Then excluded descendants and external files are absent, ordinary source files remain, and repeated discovery is deterministic. Read project.yml explicitly despite excluding `.ai-workflow` traversal.

### AC-002: Empty project for REQ-001

- Given a project with zero source files,
- When init runs,
- Then it succeeds with empty module_roots and features and consistent rendered Markdown.

### AC-003: TS/JS discovery for REQ-002

- Given TS and JS fixtures with exports, entry files and tests,
- When adapters analyze and init builds navigation,
- Then entries, tests and supported public symbols reference real files and pass semantic verification. JavaScript uses the existing TypeScript compiler capability rather than a separate ad hoc parser.

### AC-004: Java project detection for REQ-002

- Given Maven, Gradle Groovy and Gradle Kotlin fixtures with `src/main/java`, `src/test/java`, package declarations and Boot classes,
- When discovery runs,
- Then Java roots and package-based feature names are present and every recognized Boot class is an entry. Multiple Boot classes are retained in sorted order.

### AC-005: Java file coverage for REQ-003

- Given Maven and Gradle projects containing annotated classes, ordinary classes and tests,
- When init runs,
- Then every discovered Java source belongs to a generated feature as an entry or related file, with associated tests indexed as exact files.

### AC-006: Observable Spring classification for REQ-003

- Given same-package classes annotated with SpringBootApplication, Controller, RestController, Service, Repository or Configuration and an ordinary class,
- When the Java adapter recognizes these annotations,
- Then recognized classes appear in entries and the ordinary class in related_files. If a package has no recognized entry, its ordinary files become structural entries. Symbols and relations remain empty for Java structure-only analysis.

### AC-007: Java structural fallback for REQ-003

- Given a Java file whose syntax cannot be structurally classified reliably,
- When its adapter runs,
- Then the file remains a structural candidate with empty symbols and relations and the adapter returns a diagnostic containing project-relative path, code and message. A fixture must assert diagnostic and retained file together.
- Diagnostics are internal adapter results consumed by discovery and tests; they add no navigation fields or CLI response fields and are not a claim of successful semantic analysis.

### AC-008: Navigation lifecycle compatibility for REQ-004

- Given generated Java file-only, configured unknown-language file-only, TS/JS semantic and mixed-project fixtures,
- When schema validation, validateContext, feature locate with verify, and an authorized refresh are performed,
- Then generated features pass and structural coverage is preserved. Deleted indexed files or newly unclassified source files fail structural checks; exported-symbol drift still fails semantic checks. An unsupported language claiming exported-symbol capability is rejected.

### AC-009: Canonical output for REQ-004

- Given equivalent projects enumerated in different file orders,
- When navigation is serialized,
- Then JSON bytes match and Markdown equals renderNavigation(JSON).
- Use project-relative slash-separated paths, roots/features ordered by ID, path arrays by path, symbols by file/name/kind/visibility, relations by kind/from/to, diagnostics by path/code/message. Use locale-independent string comparison. De-duplicate sets; preserve any explicitly meaningful read order consistently. JSON uses two-space indentation and a final newline.

### AC-010: Conflict and publication recovery for REQ-005

- Given any existing managed target,
- When init runs,
- Then it fails before writes and existing bytes remain unchanged.
- Given an ordinary injected filesystem error during publication,
- When init fails,
- Then only files/directories created by this invocation are removed, preexisting .gitignore bytes are restored, and no partial manifest remains. Failure must be reported; abrupt process termination is excluded.

### AC-011: Digests and update protection for REQ-005

- Given a successful generated initialization,
- When manifest records are compared with actual files,
- Then recorded digests match generated bytes.
- Given any manifest containing navigation records, including records of old empty templates or records that differ from current navigation bytes,
- When update runs,
- Then both navigation files are skipped and unchanged. Other templates retain existing ownership rules. Missing navigation is not recreated by update; missing manifest still errors. Navigation maintenance uses context refresh.

### AC-012: Authoritative configuration for REQ-006

- Given valid version-1 project.yml declarations,
- When init runs,
- Then each configured module maps to one navigation root using its ID and path. Single-language modules use that language, multi-language modules use mixed. Feature module_root binds to that declared module ID.
- Module source_roots and test_roots are module-relative; feature paths are project-relative. Expand directories to concrete indexed files. Module path is the common declared ownership boundary, allowing source and test roots within it.

### AC-013: Partial and invalid configuration for REQ-006

- Given absent configuration or a valid partial configuration,
- When init runs,
- Then discover uncovered modules/files without overriding explicit features or duplicating ownership.
- Given malformed YAML, duplicate IDs, missing referenced modules, nonexistent paths, paths outside the project, overlapping module boundaries or duplicate feature file ownership,
- When init runs,
- Then report the offending configuration field/path before writes; do not silently ignore the declaration. Configuration bytes remain unchanged in all cases.

## Configuration contract

```yaml
version: 1
modules:
  - id: backend
    path: backend
    languages: [java]
    source_roots: [src/main/java]
    test_roots: [src/test/java]
features:
  - id: users
    name: Users
    module_root: backend
    paths: [backend/src/main/java/example/users, backend/src/test/java/example/users]
```

Both lists may be empty. A module declaration has one or more languages and source roots; test roots may be empty. All feature files must lie in their declared module. Uncovered files within a declared module retain that module; auto-discovered modules cover only undeclared territory. Generated IDs derive deterministically from project-relative module paths and package/path grouping; explicit IDs reserve their names and generated collisions use deterministic numeric suffixes. No hash-based identity is needed.

Use the `file` entry kind for structural capabilities; exported-symbol retains semantic meaning. For a mixed module, capability dispatch must not interpret Java files as TypeScript. New structural roots need complete file coverage without changing legacy mixed roots that predate this capability.

## Error boundaries and counterexamples

- Zero files and one file are valid; generated-only projects behave like empty projects.
- A matching annotation string in a comment or string literal is not evidence of a Spring class.
- A module may contain several source roots/languages but maps to one ownership root; overlapping declarations are not an alternative ownership mechanism.
- Ordinary unreadable source directories fail discovery before writes; Java syntax fallback does not hide filesystem errors.
- Existing navigation is an init conflict, not an input to merge. Existing project.yml alone is not a conflict.
- Scan exclusions do not authorize silent success when an explicit declaration points into excluded generated content; reject such declarations.
- Existing user changes and unrelated files survive failures, updates and implementation rollback.

## Verification layers and RED criteria

| Requirement | Acceptance criteria | Layer | RED evidence before implementation |
| --- | --- | --- | --- |
| REQ-001 | AC-001, AC-002 | Unit and integration | Discovery fixture cannot produce the required filtered inventory; empty init is a compatibility control. |
| REQ-002 | AC-003, AC-004 | Adapter unit and init integration | TS/JS or Maven/Gradle fixture produces no populated navigation. |
| REQ-003 | AC-005, AC-006, AC-007 | Adapter unit | Java coverage, annotation classification or fallback diagnostic assertion fails. |
| REQ-004 | AC-008, AC-009 | Unit and lifecycle integration | Java verification rejects a structural root, refresh loses coverage, or shuffled candidates produce different output. |
| REQ-005 | AC-010, AC-011 | Behavior and CLI integration | Injected write failure leaves partial state or update replaces generated navigation. |
| REQ-006 | AC-012, AC-013 | Config unit and integration | Declared roots are ignored or malformed/ambiguous configuration is accepted. |

Existing compatibility tests may already pass; do not manufacture their RED state. New behavior tests must fail for the missing behavior before implementation, then pass after the minimal change.

## Compatibility and rollback

Preserve init arguments and its created-path result, existing managed-file conflict behavior, navigation version 1, exact generated file scopes, and refresh candidate authorization. Project configuration is user-owned. Update intentionally changes only navigation template handling to unconditional skip.

Implementation rollback uses authorized scoped Git reverts, never destructive reset. Preserve initialized repositories and their user configuration; older tools may not validate newly introduced file capabilities, so retain the compatible CLI for those projects rather than rewriting their indexes. Ordinary failed initialization automatically restores the pre-invocation state within the stated write boundary.
