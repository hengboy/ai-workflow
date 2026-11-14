# Review dispatch reference

The primary must read this reference before a planned implementation's initial review or targeted recheck. Use the distinct packet for each role and mode; replace every placeholder with the actual value. These are native prompt bodies, not new runtime files or a JSON transport. Both axes judge the same immutable final head. Never broadcast a generic implementation task packet to a reviewer.

## Dispatch preparation

- The optional `ai-workflow review packet` and `ai-workflow plan dispatch` generators assemble only supplied fields. They never change the gates, roles, repair budget or mandatory context, and the packet below still requires every named evidence path.
- Obtain the complete execution-unit base and checked head plus raw export paths from Git Operator. A recheck additionally needs the immediately preceding reviewed `previous_head`, its blobs and the separate repair diff. The delivery base never advances to the last task or repair commit.
- Supply exact absolute paths and version anchors. Export complete diffs including deletions and both rename endpoints; include the necessary unchanged caller context at the same commits. File names alone are not evidence of completeness.
- The initial review covers every assigned AC or applicable standards dimension. A blocker does not terminate the rest of the review. Require explicit unreviewed coverage and missing material, all concrete findings and complete-findings precedence over the report target.
- Keep Spec requirement-only: no plan, task, MEMORY bundle, implementation narrative, runtime report, earlier finding, verdict or requested outcome. The contract is procedural authority and raw code is a review subject. Standards receives its own standards and test evidence instead.
- Select affected axes from actual repair impact on requirements, code, standards and their callers, never solely from which axis originally reported a defect. Record the impact and the reason an axis is unaffected in the primary's existing context; do not send that assessment to Spec. An old PASS never automatically applies to a changed head.

## Spec initial

```text
role: spec-review
mode: initial
purpose: <delivery or repository-local finalization>
repository: <absolute repository path>
contract: <absolute project contract path>
requirements: <absolute frozen requirement paths and version anchors>
requirement_scope: <all assigned requirement and AC references>
base_commit: <verified full delivery-base SHA>
head_commit: <verified full checked-head SHA>
raw_diff: <absolute complete delivery-diff path>
source_blobs: <absolute immutable source-context paths at the named commits>
committed_tests: <absolute immutable test-source paths>
instruction: Independently map every assigned AC to code and test source. Continue after a blocker and report all concrete gaps and unreviewed coverage. Return the exact range, AC evidence, verdict, findings and precise missing material. Runtime success is outside this static verdict.
```

## Standards initial

```text
role: standards-review
mode: initial
purpose: <delivery or repository-local finalization>
repository: <absolute repository path>
contract: <absolute project contract path>
memory: <absolute MEMORY path and version anchor>
note_standards: <absolute applicable note-governance paths and version anchors>
base_commit: <verified full delivery-base SHA>
head_commit: <verified full checked-head SHA>
changed_paths: <exact authorized changed paths including rename endpoints>
raw_diff: <absolute complete delivery-diff path>
source_blobs: <absolute immutable source-context paths at the named commits>
test_reports: <absolute relevant reports with commands, exit codes and checked version>
instruction: Complete every applicable standards and code-review dimension, continuing after a blocker. Report supported reachable triggers, observable impact, cited expected behavior, all concrete findings and unreviewed coverage. A passing test report is evidence to examine, never a requested verdict.
```

## Spec recheck

```text
role: spec-review
mode: recheck
purpose: <delivery or repository-local finalization>
repository: <absolute repository path>
contract: <absolute project contract path>
requirements: <absolute frozen requirement paths and unchanged version anchors>
requirement_scope: <affected requirement and AC references>
base_commit: <verified full original delivery-base SHA>
previous_head: <verified full immediately preceding reviewed-head SHA>
head_commit: <verified full checked repair-head SHA>
raw_diff: <absolute complete base-to-head delivery-diff path>
repair_diff: <absolute previous-head-to-head repair-diff path>
repair_scope: <exact repaired paths, symbols and affected caller paths>
source_blobs: <absolute necessary source paths at base, previous head and head>
committed_tests: <absolute immutable test-source paths>
instruction: Independently evaluate each affected AC and reachable repair effects. Return AC-to-code evidence and satisfied, gap or material-missing outcomes. Compare any gap with the previous head and report present-at-previous-head, repair-introduced or unknown with evidence. Report incidentally discovered real gaps and their scope relationship without starting a new full review.
```

## Standards recheck

```text
role: standards-review
mode: recheck
purpose: <delivery or repository-local finalization>
repository: <absolute repository path>
contract: <absolute project contract path>
memory: <absolute MEMORY path and applicable version anchor>
note_standards: <absolute affected note-governance paths and version anchors>
base_commit: <verified full original delivery-base SHA>
previous_head: <verified full immediately preceding reviewed-head SHA>
head_commit: <verified full checked repair-head SHA>
original_findings: <finding labels, factual triggers, cited standards and raw evidence references>
raw_diff: <absolute complete base-to-head delivery-diff path>
repair_diff: <absolute previous-head-to-head repair-diff path>
repair_scope: <exact repaired paths, symbols and affected caller paths>
source_blobs: <absolute necessary source paths at base, previous head and head>
test_reports: <absolute fresh reports with commands, exit codes and checked version>
instruction: Verify each assigned finding and repair impact using current evidence, never a claimed fix. Return closed, unresolved or material-missing dispositions. Classify new observations as present-at-previous-head, repair-introduced or unknown with concrete supported triggers. Report incidentally discovered real defects without starting a new full review.
```

## Closure and bounded continuation

The primary retains the original finding labels and maps the independent reports to them. A Spec recheck's requirement-level result does not erase an original finding whose counterexample remains unproven. Use the existing context and evidence reports, never a new persistent review ledger. For each newly observed gap, distinguish these cases:

| Observation | Primary disposition |
| --- | --- |
| Original defect remains | Keep its label open and identify the still-failing counterexample. |
| Repair introduces a reachable defect | Record repair regression with the previous-to-current comparison. |
| Defect existed at the previous head but was not reported | Record initial-review omission, or omission in the preceding recheck, with evidence; do not blame the repair without a causal change. |
| Required raw material is missing | Obtain the exact authorized material; evidence completion at an unchanged head does not consume repair budget. Unavailable required material blocks acceptance. |
| Unsupported expectation, duplicate or out-of-scope request | Give a reasoned disposition; genuine out-of-scope defects remain visible as support requests. |

Each boundary permits at most two repair/recheck cycles after its single full review. A cycle is one aggregate in-scope repair, fresh relevant checks and commits, then one fresh targeted recheck batch of affected axes; run both simultaneously when both are affected. The second cycle is automatic only for evidenced in-scope blockers with a concrete correction and either new defect evidence or demonstrable closure progress. Repeating the same finding with no progress and no new evidence stops. Missing authorization, a necessary requirement/scope change or unavailable required evidence stops immediately. If the budget is exhausted with an unresolved blocker, stop as blocked or failed and report the exact remaining trigger and evidence; never hide the defect or request PASS to fit the budget. A new session or renamed finding never resets this boundary's budget.

Integrate only after all original and new in-scope blockers close, advisory dispositions are resolved, required checks pass and every affected axis accepts its assigned scope at the final head. Carry forward unaffected coverage only with an explicit repair-impact justification. A targeted PASS is never a blanket approval of an unreviewed head.
