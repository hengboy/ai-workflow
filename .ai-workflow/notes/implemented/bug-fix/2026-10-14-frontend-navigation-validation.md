# Agent Note: Frontend navigation accepts literal `$` route segments and `export *` barrels

Status: implemented

English | [中文](2026-10-14-frontend-navigation-validation.zh.md)

## Problem

The navigation index rejected two legal frontend shapes even though discovery had indexed them normally. The exact-path guard `isExactPath` in `src/context/validate.ts`, and the module-root guard `concreteDirectory` plus the known-path guard `exactFilePath` in `src/context/fallback.ts`, treated `$` as a structural character, so a TanStack Router style route such as `apps/case/src/pages/case/detail/$caseId/index.tsx` failed with `expected an exact regular file path` during index validation; `ai-workflow init <project>`, `context validate --all` and `context locate` could not index or resolve the route, and fallback authorization blocked the same literal `$` module root and known file path with `expected a concrete project directory` or `expected an exact known file path`. Separately, feature verification in `validateTypeScriptSymbol` combined only the file's own top-level and nested declarations and assumed a referenced symbol had to be declared directly in the file, so a public definition that a generated barrel re-exports with a relative `export * from './schema.js'` was reported as `Navigation index is stale: <file> no longer contains <name>` although the barrel exports it. The generated relation must keep its endpoint on the barrel, so the definition is reached only by following the star re-export.

## Decision

- The exact-path grammar no longer treats `$` as a structural character. `isExactPath` in `src/context/validate.ts` and `concreteDirectory` plus `exactFilePath` in `src/context/fallback.ts` drop `$` from the rejected class while keeping `?`, `*`, `[`, `]`, `{`, `}`, `<` and `>`, so a literal `$` route segment is an exact path for index validation and for fallback authorization.
- Feature verification resolves a public symbol through a relative `export *` barrel re-export transitively. The private `starExportDeclarations` walks `export *` declarations over actual files, reuses the private `moduleFileCandidates` candidate order, and carries a `visited` set of real paths to stop cycles; the `declarations` helper takes an `includeDefault` flag that skips default-exported statements so a default export never resolves from `*`. Resolution runs only when `visibility === 'public'` and the direct declaration set already failed.
- Nothing else changes. Generation still indexes the barrel, generated relation endpoints stay on the barrel, and the full semantic validator and the exported API are unchanged; `moduleFileCandidates` is extracted from `directImports` with identical candidate order, so parsed relations and the full symbol set stay the same as before.

## Alternatives considered

- **Rewrite or rename the product route that carries `$`.** Declined: `$` is a legal filesystem character and the literal route directory is the delivered product shape, so the validator must accept it instead of changing the product.
- **Repoint the generated relation at the defining file for a star re-export.** Declined: feature verification and full validation must read the same index, and a relative `export *` is not an explicit named re-export, so the relation endpoint stays on the barrel and only symbol resolution follows the star.
- **Redesign the CLI or the validator surface.** Declined: the defect is a bounded guard and private-helper fix, so a CLI redesign is wider than the intent.

## Consequences

- A frontend project whose route literal contains `$` is accepted for indexing, validation and location: `ai-workflow init <project>` indexes the route, `context validate --all` accepts the index, `context locate --feature <id> --verify` returns a hit for the route feature, and fallback authorization accepts the same literal module root and known path.
- Feature verification accepts a public definition reached through a relative `export *` barrel, while a `default` export or a non-exported definition named from a barrel still does not resolve, and an actually renamed or removed definition still reports the stale message.
- Regression coverage lives in the existing `tests/integration/navigation-locate-cli.test.ts`, `tests/unit/navigation-contract.test.ts`, `tests/unit/navigation-fallback.test.ts` and `tests/unit/navigation-semantic.test.ts` cases, run with the project's vitest command; the pre-existing invalid-glob negative guard is retained. Test execution results are not reported here.
- No active note is superseded in full or in part: [the navigation candidate test coverage note](2026-09-25-navigation-candidate-tests-coverage.md) owns the earlier candidate refresh defect and keeps its decision, and this change neither removes nor changes it.
