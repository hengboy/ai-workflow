---
name: coding
description: Implements a scoped coding change, directly or from a frozen plan, with test-driven development and class-based review.
---

# Coding

Implement scoped work exclusively through delegated sub-agents and test-driven
development. Keep dispatching until complete; do not pause for progress reports
while a non-blocked delegated step remains.

## Change routing

Classify the request before dispatching and state the class in one line.

- Direct change — a small requirement, feature adjustment or defect fix with clear, bounded intent and one observable outcome: implement it without Planning, without `spec.md`, `plan.md` or task files, and without the dual-axis review. Run the relevant checks and add one focused regression test for a defect.
- Mechanical change — a typo, copy, comment, formatting or test-only adjustment with no observable behavior change: implement it and run only the narrowest relevant check.
- Planned change — a new feature, unclear or contested requirements, more than one materially different design, or a change to a public interface, persistent format, cross-module or cross-stack behavior, migration, compatibility or the project contract: implement the frozen plan and keep the dual-axis review gate.

When a planned change has no frozen plan, run Planning first, freeze and validate
`spec.md` and `plan.md`, then end the session. Follow the `planning` skill's
`## Completion checklist` for the full report and copyable prompt. A plan with at least one
non-root participating repository hands off to a new session at that workspace root
to invoke the coding skill with the absolute frozen plan directory to implement the
frozen plan, because its planning session already ran the plan-to-tasks preparation
procedure and distributed the slices; the coding session verifies the delivery gate
(`ai-workflow workspace status --plan <directory>` with every participating slice
present) before any worktree or implementation record and implements without repeating
the completed preparation. Ordinary or root-only plans hand off to a new coding session.
Do not start implementation in that planning session: no worktree, no implementation
record, no implementation or review dispatch, and no commit. The new session implements
within the frozen plan.

Never run Planning to restate a request with clear, bounded intent, and never
label a change direct to skip required checks or evidence. Ask the user only
when these rules cannot classify the request. A direct or mechanical change
still executes as one coding execution unit with its worktree and Git Operator
commit; that same automatic commit gate covers planned, direct and mechanical
changes alike, and only the planning artifacts and the dual-axis review are
skipped. Once an authorized implementation passes its relevant checks and any
applicable gate, the primary automatically delegates the scoped local commit to
the `git-operator` sub-agent (Git Operator), with no separate commit
confirmation; the mandate is implementation completion, so a planning-only
session still ends at its handoff.

## Delegation and Scheduling

- An unsplit plan is executed serially by each step's `Responsible role`: delegate
  one sub-agent for each step, wait for its result and verify it before the next.
- A split plan uses `tasks/execution-order.yaml`, an ordered list of non-empty
  parallel phases, as its only schedule: process phases in file order,
  dispatch every task of the current phase concurrently with test work before
  implementation inside each task, wait for the whole phase and verify each
  result, then commit each task's write scope through Git Operator one commit at
  a time before advancing, inside the single worktree. Only validation contention
  for shared build artifacts may serialize that phase's dispatch without changing
  the frozen order. A missing or invalid order stops the run before execution:
  never recompute phases from `depends_on` and never fall back to serial execution.
- A small bug fix or small request is delegated as one complete unit to one
  sub-agent.
- When a test must be written or changed, delegate that test work to the
  `test` sub-agent first. The implementation sub-agent may consume the test
  and fix production code, but must not write the test itself.
- Batch each role's work into one dispatch per step/task. A second dispatch to
  that role is allowed only as a review repair with new evidence or new inputs.
- The orchestrator owns scheduling, dependency progression and automatic
  continuation; interrupt only for a real blocker, failed gate, missing
  authorization or required user decision. Specialists never dispatch children.
- The primary orchestrator directly dispatches Git Operator for every per-step
  commit, merge and finalization, using the prescribed `git-commit` conventions.
  Git operations are allowed only through Git Operator, including inspection.
- Once a sub-agent returns execution Status `done`, its session is finished. Any
  later work delegated to the same named role must start a new native sub-agent
  session; never reuse or resume the completed session, including by passing its
  identifier to a continuation field or any other continuation mechanism.
- The same boundary covers later authorized implementation, repair, verification or
  recheck, documentation and Git work, grants no new authority, and never treats a
  `done` result as review PASS.
- Give the new session the current required project context, `MEMORY.md`, both
  navigation files, the project contract, the current task goal, exact read/write
  scopes, permitted commands and relevant accepted results or actionable findings
  instead of the entire previous conversation. Completed-task context can
  accumulate and degrade effectiveness; a fresh session limits that accumulation,
  and no measured performance gain is claimed.

## Surface routing

With `tasks/*.md`, route each task by its required `surface`; an empty or unknown
`surface` fails before execution. When no task files exist, route each step by its
`Responsible role`, with no plan-level routing attribute. If it cannot map uniquely
to an installed role, fail before execution and request clarification. Both inputs
use this mapping:

- `backend` → Backend Developer
- `frontend` → Frontend Developer
- `cross-stack` → Backend Developer then Frontend Developer in dependency order
- `research` → Researcher
- `documentation` → Documentation Maintainer
- `test` → Test
- `docs` → Documentation Maintainer

## Work-boundary synchronization

When this skill session begins, invoke the shared native synchronization entry
for the actual project root exactly once:
`ai-workflow sync-hook --host <current-host> --phase --project <actual-root>`.
Raw JSON has top-level `decision` (`allow`, `deny`, `skip`) and nested `report`
with `status`, `verified`, `proceed` (absent for `skip` or actor exemption). Follow
`decision`, not the exit code, which is 0 even on denial: `deny` or a `conflict` or
`failed` `report.status` stops; warnings proceed visibly without freshness claims;
`skip` means no adoption.
The manual `ai-workflow sync [project]` returns a `SyncReport` with `status`,
`verified`, `proceed` and no `decision`. The installed stdin form
`ai-workflow sync-hook --host <host>` requires the native JSON payload; never run
it by hand without that payload.

Later steps, phases and native host events reuse the actual root's stored result.
A missing, corrupt or unreadable check allows with visible no-freshness context
and no source retrieval. Preflight writes only managed instructions in the actual
root or coding worktree, with no Git or product edits. After a safe patch changes
the contract or owned rules, re-read `.ai-workflow/AGENTS.md` or inject the returned
authority before ordinary work. Frozen `spec.md`, `plan.md`, tasks and write scopes
never change; contradictions stop the
phase with bounded support instead of broader scope.

## Preconditions

- Explicitly read `.ai-workflow/AGENTS.md`, `MEMORY.md`, `.ai-workflow/index/navigation.json` and `.ai-workflow/index/navigation.md`, or receive complete context injection, before acting. The contract binds every agent. Read frozen `spec.md` and `plan.md` for planned work; a direct or mechanical change uses the request's explicit scope and acceptance evidence as its boundary.
- A plan may be implemented whole or through split tasks. An assigned
  `tasks/<taskId>.md` permits only its exact read/write scopes and declared
  commands; an unsplit plan uses its explicit scope and acceptance criteria.
- A missing/empty index is normal. Locate `missing_index` or feature `miss` does
  not block paths/symbols supplied by the plan or authorized bounded discovery.
  For unsplit work, use the frozen scope; request File Explorer only for an unclear
  boundary, never merely for an absent indexed feature.
- For a child-participating parent/root plan, a repository slice or workspace
  finalization, explicitly read `references/workspace.md` before any workspace
  preparation, worktree, implementation record, task dispatch or finalization.
  Include missing manifests and claimed workspace/slice mismatches and their refusal
  routes. Both files are authority together; a link does not load the reference.
- Before implementation, Git Operator must create one project-local temporary worktree
  under `<project>/.worktrees/<name>` with `.worktrees/` in `.gitignore`, then
  materialize the project's entire gitignored state into it except `.worktrees/`.
  `.ai-workflow/plans/` and dependencies stay visible and single-source at the project root;
  `MEMORY.md`, navigation and notes arrive through Git. Every coding execution unit
  implements, validates and commits inside that single worktree; merge/remove only
  its owned worktree and branch. Planning and TDD depth stay risk-proportional while
  review boundaries follow the change class.
- Create a Todo list before editing and keep it current. Each step must state its
  scope, acceptance evidence and commit point.
- Use a Todo list when it improves clarity; keep it proportional to the change.

## Procedure

1. Choose one behavior/boundary from an acceptance criterion. State each test's
   public interface and observable boundary for Test; stop for clarification if unclear.
2. Have Test write one behavior test, then run it to confirm its expected failure. A test that
   passes initially is not coverage evidence; investigate before continuing. For a
   defect, first reproduce it with a stable public-interface regression test and
   retain it after the direct fix.
3. Write only the smallest production change that makes that test pass, and run
   the same test again.
4. Repeat steps 1-3 vertically for every behavior. Do not write all tests first
   and implement them later.
5. Only after all slices pass, perform a small refactor when it removes duplication
   created by this work; rerun affected tests.
6. Complete validation and scoped commits under the gate below.

Name tests as behavioral specifications with independent expected values. Test
stable public boundaries only: never test private methods, internal collaborators
or implementation shape; avoid same-algorithm expectations, internal collaborator
mocks and constant-only assertions.
Never weaken assertions, suppress failures or add unrelated compatibility layers.

## Verification and Commit

Choose checks/commits by risk and repository practice. Run the narrowest relevant
test after each slice, then all declared validation commands, including required
typecheck, lint, build or integration checks. Report changed paths and every result.
Self-check once per step and dispatch Git Operator for its scoped commit, retaining
the split-plan whole-phase barrier and serial commits.

After implementation, run relevant validation. An ordinary planned change, split
or unsplit, runs one simultaneous full Spec Review and Standards Review batch after
implementation and its required checks and before integration: delegate Spec Review
and Standards Review simultaneously in one parallel batch with identical evidence,
never Spec first and Standards after Spec completes. This is the review-side
exception to serial dispatch; request Test as useful. Spec Review checks frozen
requirements and acceptance criteria; Standards Review checks `MEMORY.md`.
There is no per-task, per-phase or per-commit review trigger, and no undefined
larger or high-risk trigger beyond the change class. A direct or mechanical change
runs the relevant checks without the dual-axis review.

The primary aggregates both axes' findings and automatically delegates one aggregate
repair for evidenced defects within the frozen acceptance and existing write scope,
without asking which findings to fix and with no separate routine selection. Test
authors required test changes before the implementation role edits production code;
authorized commands may collect missing evidence. An unfulfilled AC, a cited
required-standard violation or missing required evidence is a blocker. Warnings are
advisory and must carry a reasoned disposition; a warning never masks a blocker. Demonstrably unsupported or duplicate findings also require reasoned dispositions and must not be silently dropped.

Each boundary permits at most one targeted recheck batch after the one aggregate
repair: dispatch only the affected axes, and when both axes are affected, dispatch
them simultaneously in one batch. The recheck binds the original finding labels, the
repair diff, the affected REQ/AC or `MEMORY.md` clauses and fresh evidence including
repair-induced regressions; it never starts a second full repository review.
Reviewers stay read-only and Test runs the commands. An unresolved blocker or an
unavailable recheck stops as `blocked` or `failed` with bounded support; there is no
second repair or review loop.

Once an authorized implementation passes the relevant checks and any applicable
gate, the primary automatically delegates the scoped local commit to the
`git-operator` sub-agent (Git Operator) for planned, direct and mechanical
changes, with no separate user confirmation; this commit completes the
implementation, a no-scoped-diff execution unit returns Git Operator's verified
no-change evidence with the current HEAD SHA instead of an empty commit, and a
failed or blocked commit is reported as `blocked` or `failed`, never `done`.

Before a non-fast-forward integration of the temporary branch, the primary supplies
the exact accepted source HEAD, repository, worktree, purpose, base and target plus
the semantic review and check evidence. Git Operator alone compares the actual clean
source HEAD with that accepted HEAD and refuses drift before merge; the resulting
delivery merge SHA is recorded separately and need not equal the source HEAD. After
all steps and the applicable gate, Git Operator merges the temporary branch, reruns
affected checks and removes only the owned worktree/branch. Never stage unrelated
user changes, expand scope, search outside the packet, publish or edit frozen
planning artifacts.

## Note Maintenance

- Before landing a change, load `.ai-workflow/AGENTS.md`, `.ai-workflow/notes/AGENTS.md` and `.ai-workflow/notes/README.md`; the README is the single source for note format, lifecycle, supersession and archive governance.
- Create or update a note only for a lasting decision whose rationale code, tests and existing documentation cannot adequately explain; behavior changes, file counts and added tests are insufficient on their own, and local, mechanical, UI, copy and formatting changes without such lasting rationale are exempt. Reuse a still-accurate note that owns the same decision and keep its facts current in the same change; record a changed decision or lasting rationale as a new linked note.
- When a decision lands, move its record to `implemented` and rewrite its body as delivered facts, not only its status. A changed decision or rationale requires a new note; assess related active-note supersession within scope.
- Add relevant notes and governance to explicit bounded read/write scopes, never the entire notes history. After landing the note, run `ai-workflow notes validate --project <absolute-project-root>` and report the result.

## Implementation Record

Do not generate workflow manifests or run records except the single permitted
implementation record at `<project>/.ai-workflow/plans/<planId>/implementation.yaml`.
Only a frozen plan creates this record. A direct or mechanical change without a
frozen plan creates no record. The only two status values are `in-progress` and
`completed`; no failure status exists. Every timestamp is ISO 8601 in UTC+08:00,
for example `2026-09-23T15:04:05+08:00`.

Preserve `plan_id`, existing `started_at` and any `root_tasks_commit` on updates.
Completion follows final merge and cleanup of only the owned worktree and branch.

| Lifecycle point | Same-record update |
| --- | --- |
| Before the first implementation step | Write `plan_id`, `status: in-progress` and `started_at`, with no `completed_at`. |
| Resume or interruption | Keep the start record; interrupted work stays `in-progress`, never with a failure or abandonment reason. Later success rewrites it as completed. |
| Ordinary plan, root-only plan or child slice completion | Update in place (idempotent) to `status: completed`, `completed_at` and final commit SHA (`commit`). If the start record is missing, still write a valid completed record that omits `started_at`. |
| Child-participating root task delivery | After merge and owned cleanup, keep `status: in-progress` with full lowercase 40- or 64-hex `root_tasks_commit`; no `completed_at` or final `commit` until pointer finalization. One record, no new status or artifact. |
| Child-participating root without tasks | Delivery is implicit with a null commit: no artificial root-delivery worktree or record; create a worktree only for authorized finalization. |
| Root finalization | Stay `in-progress` through interruption; after final merge and owned cleanup, set `status: completed`, `completed_at` and final workspace `commit`, retaining root delivery evidence. |
| Completed root finalization reentry | Verify matching `plan_id`, full final commit and delivery/pointer evidence read-only. Report without a new worktree, record rewrite or task reexecution; invalid/unavailable evidence requires bounded support. |

Workspace execution adds the fields and checkpoint-only write protocol in
`references/workspace.md`; explicitly read it before any workspace record operation.

## Workspace root sessions

For parent `workspace.yaml` with `role: workspace` and a non-root participant,
explicitly read `references/workspace.md` before creating a worktree or implementation
record; apply its root identity, delivery gate and root task/finalization-only routes.

## Parent workspace execution

Activate only when the frozen plan declares at least one participating non-root
repository matched to the current root's `.gitmodules`. Ordinary plans, root-only
plans whose `workspace_repos` declares only the reserved workspace root entry,
and projects with `.gitmodules` running a non-participating plan gain no workspace
prerequisites; root-only plans may be implemented unsplit. Claimed workspaces with
absent, mismatched or escaped declarations are refused, with no child-in-root fallback.
Explicitly read `references/workspace.md` before approved preparation or any
implementation state, then follow its parent execution and recovery procedure.

## Slice sessions

Explicitly read `references/workspace.md` and the slice manifest `workspace.yaml`
before any other slice step. A missing manifest or identity/status mismatch refuses
before creating a worktree or implementation record; apply the reference's independent
slice scope, completion and handoff route.

## Workspace finalization

Explicitly read `references/workspace.md` before finalization or pointer/index
mutation. It requires status, entire-batch existence and separate review gates;
`all slices are completed` alone is insufficient. The correct running parent/root
session finalizes directly.

## Note ownership

Explicitly read `references/workspace.md` before workspace note maintenance for
repository ownership and plain plan-ID references; also apply Note Maintenance above.

## Completion checklist

- The change class was stated at intake and matches the delivered scope; direct
  and mechanical changes carry relevant check evidence without planning artifacts.
- A planned change without a frozen plan ended the session after Planning with
  its handoff and no implementation state.
- Every assigned REQ/AC, or the direct change's stated outcome, has implementation
  and test evidence from a completed red -> green slice.
- Every slice was verified, self-checked once, and committed before the next
  slice began; commits contain only that slice's scoped changes.
- The primary automatically delegated the scoped local commit to the
  `git-operator` sub-agent (Git Operator) once the relevant checks and any
  applicable gate passed, and recorded the returned commit SHA or, for a
  no-scoped-diff execution unit, Git Operator's verified no-change evidence with
  the current HEAD SHA; a failed or blocked commit was reported as `blocked` or
  `failed`, never as `done`.
- Negative cases and failure output are reported truthfully.
- Screenshots remain under `.ai-workflow/plans/<planId>/screenshot/`.
- Any lasting decision that required a note updated its relevant record and `ai-workflow notes validate` passed; changes without such lasting rationale added no note.
- Return `done` only when all scoped checks pass and the `git-operator`
  sub-agent (Git Operator) returned the scoped commit SHA or verified no-change
  evidence with the current HEAD SHA; otherwise return `blocked` or `failed`
  with support requests.
