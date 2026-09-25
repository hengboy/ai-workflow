# Agent Note: Navigation candidate refresh applies the analyzer's test classification

Status: implemented

English | [中文](2026-09-25-navigation-candidate-tests-coverage.zh.md)

## Problem

The sanctioned navigation refresh flow could not classify newly added test files. `createNavigationCandidate` in `src/context/validate.ts` rebuilt each changed feature from the analyzer result by assigning `entries`, `related_files`, `symbols` and `relations`, but it never assigned the analyzer's `tests` array, so a generated candidate kept the stale `tests` value from the authoritative index. When the changed module root contained a test module root such as `tests`, `context refresh --write` then failed `validateModuleCoverage` with `Navigation index is stale: unclassified module file tests/...`, because the new test files existed on disk but appeared in no feature's `tests`, `entries`, `related_files` or symbol files, and the derived `read_scope` inherited the same gap. That failure blocked the index update that the project contract and MEMORY require when public symbols and paths change.

## Decision

- `createNavigationCandidate` applies the analyzer's result directly: `current.tests = [...new Set(candidate.tests)].sort(compareStrings)`, and the recomputed `read_scope` includes `current.tests` together with `current.entries` and `current.related_files`. The analyzer in `src/context/discovery/typescript.ts` already returned the correct test classification for each module root through `DiscoveryCandidate.tests`; only the assignment was missing.
- Verification is the regression case `classifies a new test file when generating a candidate for a test module root` in `tests/integration/navigation-refresh-cli.test.ts`, which generates a candidate for a `tests` module root with a new test file, asserts the generated `tests` array, then runs `context refresh --write` and `context validate --all`; the refreshed index passes `context validate --all` with `{"valid": true, "errors": []}`.

## Alternatives considered

- **Edit `.ai-workflow/index/navigation.json` and `.ai-workflow/index/navigation.md` by hand.** Declined: the sanctioned flow owns the authoritative index, and a manual edit bypasses candidate validation, the authorized-root boundary and the candidate's maintenance authorization.
- **Specialize the analyzer's roots so a test module root is classified differently.** Declined: the analyzer already returns the correct classification for the `tests` module root, so the missing assignment was the only defect and an analyzer change would add behavior for a case that already works.
- **Leave the index stale and accept the validation failure.** Declined: the project contract and MEMORY require updating the navigation index when public symbols and paths change, so a stale index blocks the change instead of being an acceptable end state.

## Consequences

- New test files under an authorized test module root are classified by the refresh flow: a generated candidate no longer keeps a stale `tests` array, `context refresh --write` succeeds, and `context validate --all` reports `{"valid": true, "errors": []}`.
- `read_scope` stays consistent with the classification because it is derived from `entries`, `related_files` and `tests`, so a reader of a test feature can reach the new test files.
- The regenerated index also absorbed the remaining drift inside the authorized module roots, including the new `src/install/opencode-version.ts` and `src/workflow/order.ts` modules, their public symbols and relations, and six previously unclassified test files such as `tests/behavior/plan-execution-order.test.ts` and `tests/unit/workflow-execution-order.test.ts`.
- No active note is superseded in full or in part: [the task execution order record](../process/2026-09-25-task-execution-order.md) owns the split schedule during which this defect was found and keeps its decision, and no active note owns the navigation candidate refresh flow.
