---
name: coding
description: Implements a scoped coding change, directly or from a frozen plan, with test-driven development and risk-proportional review.
---

# Coding

Implement scoped coding work exclusively through delegated sub-agents and
test-driven development. The orchestrating agent must keep dispatching until
the scoped work is complete; it must not pause for progress reports while a
non-blocked delegated step remains.

## Change routing

Classify the request before dispatching and state the class in one line.

- Direct change — a small requirement, feature adjustment or defect fix with clear, bounded intent and one observable outcome: implement it without Planning, without `spec.md`, `plan.md` or task files, and without the dual-axis review. Run the relevant checks and add one focused regression test for a defect.
- Mechanical change — a typo, copy, comment, formatting or test-only adjustment with no observable behavior change: implement it and run only the narrowest relevant check.
- Planned change — a new feature, unclear or contested requirements, more than one materially different design, or a change to a public interface, persistent format, cross-module or cross-stack behavior, migration, compatibility or the project contract: implement the frozen plan and keep the dual-axis review gate.

When a planned change has no frozen plan, run Planning first, then stop: freeze
and validate `spec.md` and `plan.md` as the `planning` skill requires. When the
plan declares at least one non-root participating repository, report the absolute
workspace root, the frozen plan directory and the `plan validate` result, and
tell the user to start a new session at that workspace root and invoke the coding
skill with the absolute frozen plan directory. That coding session runs the
`approved preparation` when the task set is absent — invoking `plan-to-tasks` as
its `preparation procedure` — and runs `ai-workflow workspace distribute --plan
<directory>` before any implementation state, then continues implementation in
the same session. For an ordinary plan or a root-only workspace plan whose
`workspace_repos` declares only the reserved workspace root entry, tell the user
to start a new session and invoke the coding skill to implement it. Do not start
implementation in that planning session: no worktree, no implementation record,
no implementation or review dispatch, and no commit. Implementation resumes only
in the new session, where the frozen plan is the boundary. The `planning` skill's
`## Completion checklist` owns the full handoff report — the absolute project or
workspace root, the frozen plan directory, the `plan validate` result, each
participant's name, path and `depends_on` order, and the copyable prompt — so
this paragraph defers to that checklist instead of improvising a partial
independent handoff.

Never run Planning to restate a request with clear, bounded intent, and never
label a change direct to skip required checks or evidence. Ask the user only
when these rules cannot classify the request. A direct or mechanical change
still executes as one coding execution unit with its worktree and Git Operator
commit; only the planning artifacts and the dual-axis review are skipped.

## Delegation and Scheduling

- An unsplit plan is executed serially by each step's `Responsible role`:
  delegate one sub-agent for each plan
  step, wait for its result, verify it, then dispatch the next step.
- A split plan is scheduled by `tasks/execution-order.yaml`, an ordered list of
  non-empty parallel phases, as its only schedule: process phases in file order,
  dispatch every task of the current phase concurrently with test work before
  implementation inside each task, wait for the whole phase and verify each
  result, then commit each task's write scope through Git Operator one commit at
  a time before advancing. Every phase runs inside the single worktree the coding
  execution unit created. When a phase's validation commands contend for shared
  build artifacts, the orchestrator may serialize that phase's dispatch without
  changing the frozen order. A missing or invalid order stops the run before
  execution instead of falling back: never recompute phases from `depends_on`
  and never fall back to serial execution.
- A small bug fix or small request is delegated as one complete unit to one
  sub-agent.
- The orchestrator owns scheduling, dependency progression and automatic
  continuation. Interrupt the sequence only for a real blocker, failed gate,
  missing authorization or required user decision.
- When a test must be written or changed, delegate that test work to the
  `test` sub-agent first. The implementation sub-agent may consume the test
  and fix production code, but must not write the test itself.
- Do not dispatch the same sub-agent role more than once for the same plan
  step or task; batch all work for that role into its single delegation. A
  second dispatch to the same role is allowed only as a review repair with new
  evidence or new inputs.
- The primary orchestrator directly dispatches Git Operator for every per-step commit, merge and finalization; Git Operator is the only role allowed to run Git and uses the prescribed `git-commit` conventions, and specialists never dispatch children.
- The dual-axis reviews are the review-side exception to serial dispatch: delegate Spec Review and Standards Review simultaneously in one parallel batch with identical evidence; do not delegate Spec first and only delegate Standards after Spec completes.

## Surface routing

Surface routing applies only when `tasks/*.md` files exist. Each task must have
an explicit `surface` attribute, and route it to the directly dispatched role:

- `backend` → Backend Developer
- `frontend` → Frontend Developer
- `cross-stack` → Backend Developer then Frontend Developer in dependency order
- `research` → Researcher
- `documentation` → Documentation Maintainer
- `test` → Test
- `docs` → Documentation Maintainer

An empty or unknown `surface` fails before execution.

When no task files exist, execute the unsplit plan serially and route each step
by its `Responsible role`; no plan-level routing attribute is required. Use this
mapping: `backend` → Backend Developer, `frontend` → Frontend Developer,
`cross-stack` → Backend Developer then Frontend Developer in dependency order,
`research` → Researcher, `documentation` or `docs` → Documentation Maintainer,
and `test` → Test. If a Responsible role cannot be mapped uniquely to one
installed role, fail before execution and request clarification.

## Work-boundary synchronization

When this skill session begins, invoke the shared native synchronization entry for the actual
project root exactly once:
`ai-workflow sync-hook --host <current-host> --phase --project <actual-root>`.
It prints the raw gate JSON: the top-level `decision` is `allow`, `deny` or `skip`, the nested
`report` (absent for `skip` or an actor exemption) carries `status`, `verified` and `proceed`,
and the process exits 0 even when it denies. Follow `decision` rather than the exit code: `deny`
or a `conflict` or `failed` `report.status` stops the phase, a warning `report.status` proceeds
with visible context but no freshness claim, and `skip` means no adoption was found. The manual
`ai-workflow sync [project]` command instead prints a `SyncReport` with `status`, `verified` and
`proceed` and no `decision`. The installed host entry passes the native JSON payload to
`ai-workflow sync-hook --host <host>` on stdin and must not be run by hand without it.

- Later implementation steps, frozen execution-order phases and native host events in this skill
  session reuse the stored result for the actual root instead of synchronizing again, and a
  missing, corrupt or unreadable stored check allows with a visible no-freshness context rather
  than retrieving the source.
- After a safe patch changes the project contract or owned workflow rules, re-read the updated
  `.ai-workflow/AGENTS.md` (or inject the returned authority) before ordinary work continues.
- Frozen `spec.md`, `plan.md`, task files and their declared write scopes are never changed;
  when the updated authority contradicts the frozen scope, stop that phase and return a
  bounded support request instead of broadening scope.

The preflight is a narrow instruction-maintenance step in the actual root or coding worktree:
it writes only the managed workflow instruction files, performs no Git, and never edits
product code.

## Preconditions

- Read `.ai-workflow/AGENTS.md`, `MEMORY.md` and both navigation index files. Read the frozen `spec.md` and `plan.md` for a planned change; a direct or mechanical change uses the request's explicit scope and acceptance evidence as its boundary. The project contract applies to the whole project and to every participating agent.
- A plan may be implemented either as a whole or through its split tasks. When a
  `tasks/<taskId>.md` is assigned, use only that task's exact read and write
  scopes and declared commands. When no task files exist, use the frozen plan's
  explicit scope and acceptance criteria as the implementation boundary.
- A missing or empty navigation index is normal for a new project. A locate
  `missing_index` or feature `miss` result must not block implementation when
  the plan (or an authorized bounded discovery result) identifies the paths and
  symbols. For an unsplit plan, do not invoke File Explorer merely because the
  feature is absent from the index; use the frozen plan's scope directly.
  Request File Explorer only when the implementation boundary remains unclear.
- A session asked to implement a workspace plan that declares at least one non-root participating repository must confirm the delivery gate first with `ai-workflow workspace status --plan <directory>` using the absolute parent workspace plan directory. Require `valid: true`, the validated frozen `tasks/execution-order.yaml` and every child slice `present`; an invalid report or any missing or divergent slice refuses before creating a worktree or an implementation record. Direct to a session at the parent workspace root that invokes plan-to-tasks with the absolute parent plan directory when the plan still needs splitting, or reruns `ai-workflow workspace distribute --plan <directory>` with the same absolute parent plan directory after repairing the named divergence when the split artifacts exist. A root-only workspace plan whose `workspace_repos` declares only the reserved `workspace` root entry is exempt and may be implemented unsplit.
- Before implementation, Git Operator must create one project-local temporary worktree
  under `<project>/.worktrees/<name>` (ensure `.gitignore` contains
  `.worktrees/`). Git Operator must then materialize the project's entire
  gitignored state into the worktree, excluding only the `.worktrees/` container,
  so `.ai-workflow/plans/` and dependencies stay visible and single-source at
  the project root; `MEMORY.md`, navigation and notes travel with Git and arrive
  with the worktree. This is a mandatory step of
  every coding execution unit, not an option reserved for high-risk work: all
  implementation, validation and per-step commits happen inside that single
  worktree, and only the owned worktree and branch are merged and removed at the
  end. Planning, TDD and review depth remain proportional to change risk.
- Create a Todo list before editing and keep it current. Each step must state its
  scope, acceptance evidence and commit point.
- Before writing a test, state the public interface and observable boundary it
  will exercise and provide it to the `test` sub-agent. If that boundary is
  unclear, stop and request clarification.

## Pre-Implementation Todo

Use a Todo list when it improves clarity; keep it proportional to the change.

## Step Execution, Verification and Commit

Choose focused tests and commits according to task risk and repository practice.

## Procedure

1. Choose one behavior or boundary from one acceptance criterion.
2. Write one behavior-level test against the public interface, then run it and
   confirm it fails for the expected reason. A test that already passes is not
   evidence; investigate before continuing.
3. Write only the smallest production change that makes that test pass, and run
   the same test again.
4. Repeat steps 1-3 vertically for every behavior. Do not write all tests first
   and implement them later.
5. Only after all slices pass, perform a small refactor when it removes
   duplication created by this work; rerun affected tests after refactoring.
6. Run the task's complete validation commands and report every changed path and
   check result.

After implementation, run relevant validation. For a planned or other larger or
high-risk change, delegate Spec Review and Standards Review simultaneously in
one parallel batch (never Spec first and Standards after Spec completes) and
request Test as useful. A direct or mechanical change runs the relevant checks
without the dual-axis review.
Collect every finding from both axes and present the findings to the user for a
choice of selected repairs or repairing all findings. Do not merge the
temporary branch or worktree until the user's repair choice is resolved. A
review repair does not trigger a second Spec Review or Standards Review. Only
after this single dual-axis review gate is resolved may Git Operator merge the
temporary branch back, rerun affected checks, and remove only the owned
worktree and branch. Never stage unrelated user changes.

## Note Maintenance

- Before landing a change, load the project contract and note governance: `.ai-workflow/AGENTS.md`, `.ai-workflow/notes/AGENTS.md` and `.ai-workflow/notes/README.md`. The README is the single source for note format, lifecycle, supersession and archive governance; do not restate those rules here.
- Every non-mechanical change adds or updates at least one relevant note in the same change, including behavior, architecture, cross-file contracts, processes, testing strategy, configuration or persistent formats. Purely mechanical or local edits that change none of these may be exempt.
- When a decision lands, move its record to `implemented` and rewrite the body as delivered facts instead of changing only its status. Record a changed decision or rationale in a new note, and assess supersession of related active notes within the authorized scope.
- After landing the note, run `ai-workflow notes validate --project <absolute-project-root>` and report the result. Add relevant notes and governance files to explicit bounded read/write scopes; never load the entire notes history.

## Test Boundaries

Tests must use public interfaces and observable behavior. Before writing each
test, identify the interface and boundary it exercises; stop and request
clarification if that boundary is unclear.

## Test quality

- Use independent expected values and preserve regression tests for defects.
- Name tests as behavioral specifications. Test stable public boundaries only;
  never test private methods, internal collaborators or implementation shape.
- Do not weaken assertions, suppress failures, or add unrelated compatibility layers.
- Run the narrowest relevant test first, then the required typecheck, lint, build or integration checks.

For a defect, first add a stable public-interface regression test that reproduces
the defect and verify it fails. Keep that test after the direct fix.

## Anti-Patterns to Avoid

Avoid same-algorithm expectations, mocks of internal collaborators, private
method tests, and tests that merely assert constants or implementation details.
Do not write all tests first and implement them later.

## Red -> Green Loop

For each behavior, write one failing test, confirm the expected failure, add the
smallest implementation that makes it pass, and rerun it before choosing the
next behavior. A test that passes initially is not coverage evidence.

## Verification and Commit

Run the narrowest relevant test after each slice, then the declared typecheck,
lint, build or integration checks. After each step, self-check once and dispatch
Git Operator to commit only that step using the prescribed `git-commit`
conventions; after all steps merge the temporary branch,
rerun affected checks, and clean up only the owned worktree and branch.

For a planned or other larger or high-risk change, the dual-axis review runs exactly once after implementation completes:
delegate Spec Review and Standards Review simultaneously in one parallel batch.
A direct or mechanical change completes with its relevant checks and commits without the dual-axis review.
Spec Review checks the frozen requirements and acceptance criteria, while
Standards Review checks `MEMORY.md`. Report both reviewers' findings together
and wait for the user's repair selection. Never merge code before this gate is
resolved.

Do not generate workflow manifests or run records. Do not expand scope, search outside the packet, publish, or edit frozen planning artifacts. Git operations are allowed only through Git Operator, which uses the prescribed `git-commit` conventions.

## Implementation Record

Before the first implementation step, write the single permitted run record at
`<project>/.ai-workflow/plans/<planId>/implementation.yaml`; it is the only run
record coding may create, and no other workflow manifest or run record may be
generated. It holds `plan_id` and `status: in-progress` with an ISO 8601
`started_at` in the UTC+08:00 timezone (for example
`2026-09-23T15:04:05+08:00`), and no `completed_at`.
On resume, preserve the existing `started_at` and any `root_tasks_commit` in the
same record instead of replacing the start record.

Only a frozen plan creates this implementation record. A direct or mechanical
change without a frozen plan creates no record.

For an ordinary plan, a root-only workspace plan or a child slice, after the final
merge and the cleanup of only the run-owned worktree and branch,
update that same file in place to `status: completed` with an ISO 8601
`completed_at` in the UTC+08:00 timezone and the final commit SHA, preserving
`plan_id` and `started_at`.
The update is idempotent. When the start record is missing, still write a valid
completed record that omits `started_at`.

An interrupted implementation leaves this record at `status: in-progress` with
`plan_id` and `started_at`, retaining `root_tasks_commit` if root delivery already
succeeded, and never a failure or abandonment reason. A
later successful implementation of the same plan rewrites it as a completed
record.

The record has only two status values, `in-progress` and `completed`; no failure
status exists.

## Workspace root sessions

For a parent `workspace.yaml` with `role: workspace` and at least one non-root
participant, run the delivery gate against the original parent plan and validate
the frozen order before creating a worktree or an implementation record. Require
the current project root to equal the reported absolute `workspace_root`. Execute
root delivery only when `next_repository` is `workspace` and
`workspace_root_entry.tasks_delivered` is false; otherwise hand off the reported
next repository or enter finalization when ready. Ordinary and root-only plans
keep the existing completion semantics.

Select only tasks whose `task.repo` is `workspace`. Filter the parent phases in
memory to those task IDs, preserve file order and remove empty phases; never edit
`tasks/execution-order.yaml` or recompute the DAG. Execute only this root-owned
task sequence in the single coding worktree, with its normal validation and
review gate; never dispatch sibling tasks.

After all root tasks pass, merge and perform only owned cleanup, then keep the
SAME `implementation.yaml` record at `status: in-progress` with
`root_tasks_commit` set to the delivered full lowercase 40- or 64-hex commit SHA.
Preserve `plan_id` and `started_at`, with no `completed_at` or final `commit` until
pointer finalization. Root delivery uses one record and no new status or artifact.
Report the root delivery SHA, rerun parent status and hand off its `next_repository`.

When `tasks_delivered` is true, skip delivered root tasks and all sibling tasks.
A finalization-only session executes zero tasks and does not rerun root reviews;
it preserves `root_tasks_commit` and `started_at`, including after interrupted
finalization, and proceeds only through the finalization gate below. With no root
tasks, delivery is implicit with a null delivery commit: do not create an
artificial root-delivery worktree or record; create a worktree only for authorized
finalization. After finalization's merge and owned cleanup, the same record becomes
`status: completed` with `completed_at` and the final workspace `commit`, retaining
`root_tasks_commit` when present.

Completed root finalization is idempotent: verify the matching `plan_id`, the full
recorded final commit and its delivery/pointer evidence read-only, then report the
existing result without recreating a worktree, rewriting the record or reexecuting
tasks. Invalid or unavailable evidence stops with a bounded support request.

## Parent workspace execution

Activate this route only when the frozen plan declares at least one participating
non-root repository that is matched to the current root's `.gitmodules`. An
ordinary plan, a root-only workspace plan whose `workspace_repos` declares only
the reserved workspace root entry, and a project whose `.gitmodules` has no
matching participant all keep the ordinary or root-only route above and gain no
workspace prerequisites. A claimed workspace with absent, mismatched or escaped
declarations is refused, not silently run as a single-repository task set. The
detailed procedure lives in `references/workspace.md`.

The primary parent session is the only dispatcher: it directly dispatches native
leaf agents for the active repositories with no nested coordinator, no child host
process and no sibling session, so the one already-running primary drives every
participating repository. No splitter sub-agent, scheduler service or remote
executor substitutes for it.

Before any implementation state, the primary runs the `approved preparation` and
`ai-workflow workspace distribute --plan <directory>` against the absolute parent
plan directory; distribution writes each participant's slice only after its
read-only preconditions pass. The approved preparation invokes `plan-to-tasks` as
a `preparation procedure`: it shows the full approval preview, obtains `approval`,
writes and validates the complete task triplets, the schedule and the manifest,
then runs the distribution command and `returns control` to the same parent
Coding session, which continues with implementation. A declined approval creates
no tasks, no slices, no worktrees and no implementation records. Valid
existing split artifacts are reused `byte-unchanged`; a partial or invalid task
set or a divergent slice stops with a `repair request` instead of regeneration.
This route never requires a manual child session, a separate child host process
or a sibling session. Capture the original parent
`tasks/execution-order.yaml` as the only global task schedule, process its phases
in file order, dispatch the independent tasks of the current phase concurrently,
and keep the whole phase awaited and verified before task commits are performed
serially through Git Operator one commit at a time in the phase's listed order.
Never recompute the schedule from a slice's filtered phases or `depends_on`.

Each active repository owns exactly one run-owned worktree per active repository
at `<source-root>/.worktrees/<planId>` on branch `ai-workflow/<planId>`; the
parent worktree is not a container for child implementation, so its submodule
directories stay empty while a child's source edits happen only in that child's
own worktree.

Every dispatched packet carries the exact absolute parent plan/root, the source
repository, the local slice plan, the coding worktree, the phase/task identifier,
the assigned REQ/AC, the relative and resolved read/write scope, the permitted
commands, the output paths and the upstream delivery evidence, and every command
uses an explicit workdir. A native permission denial is a blocker, not permission
to bypass the host or create a different worktree.

After a repository's last task phase, complete its per-repository delivery review
and repository delivery gate before dependent repositories advance; capture the
delivery commit and release the dependents. Root-prefix delivery keeps the same
in-progress record with `root_tasks_commit`. Finalization has its own separate
finalization review and does not re-review delivered tasks.

Checkpoints use only
`ai-workflow workspace checkpoint --plan <directory> --repo <name>` after Git
evidence: commit a task's exact scope through Git Operator, verify the commit
parentage and both rename endpoints, then record `kind: commit` with its full
SHA; record `kind: no-change` with the exact verified HEAD for a genuinely
unchanged task and create no empty commit. The command is filesystem-only and
writes only that repository's existing `implementation.yaml`; create no extra run
record.

Automatic resume is allowed only at a clean, fully checkpointed phase boundary or
a verified repository delivery boundary. A dirty partial-phase residue, a
commit-without-checkpoint gap, unknown future-phase progress, uncertain review
results or a contradictory record stops with bounded support instead of
redispatch. Already recorded tasks are identified and never blindly dispatched
again, and no fallback runs child tasks in the root.

## Slice sessions

A workspace plan can hand this repository its own slice through a `slice manifest`.
Read `workspace.yaml` before any other step. Run parent workspace status using the original
absolute parent plan directory and require `valid: true`, the current repository to equal
`next_repository`, and its slice to be `present`. The slice matches only when the absolute current
project directory equals the reported workspace root plus the manifest's declared repository path; when it
`does not match`, the slice belongs to another repository and the session `refuses` it
`before creating a worktree` or an `implementation record`. Do not create a branch, worktree or
record for a mismatched slice; return a bounded support request naming the expected and actual
repository.
An invalid report, wrong delivery position or missing or divergent slice also refuses before
creating a worktree or an implementation record; frozen inputs are never repaired in coding.

When the plan directory for a participating repository has no slice `workspace.yaml`, stop
before creating a worktree or an implementation record, report the missing manifest for that
repository, and direct to a session at the parent workspace root that reruns
`ai-workflow workspace distribute --plan <directory>` with the same absolute parent workspace
plan directory as the repair.

A matching slice session `implements only` its `slice tasks` `inside that repository` and
keeps every edit, note and record inside that repository. It never edits a sibling slice or
the workspace root. When the slice tasks are complete, record the resulting `delivery commit`
SHA and report it to the workspace orchestrator; the workspace root pins that commit later.
After reporting the delivery SHA, run `ai-workflow workspace status --plan <directory>` with the
absolute parent workspace plan directory and hand off the next repository, path, session and
copyable prompt in the frozen delivery order, reusing the split handoff's concrete conventions:
working directory `<repository-root>`, local frozen plan directory `<repository-plan-directory>`
and the original parent `<workspace-plan-directory>`. The validated `next_repository` includes
pending root-owned tasks; when it is `workspace`, hand off a root delivery session. When it is
null and `ready_for_finalization` and `workspace_root_entry.tasks_delivered` are true, hand off
a new root session for finalization. A child session never finalizes by itself.

Repository-scoped completion runs `ai-workflow plan validate` for the slice plan,
`ai-workflow notes validate` for that repository's notes, and updates that repository's
`MEMORY.md` in the same change.

## Workspace finalization

The workspace-root plan's `all slices are completed` condition is necessary but not sufficient.
Run `ai-workflow workspace status --plan <directory>` against the original parent workspace plan
directory `<workspace-plan-directory>`. Its `valid: true` requires the frozen plan, tasks,
schedule and manifest to pass the same validation as distribution. Finalization requires every
child `slice` to be `present`, every child `record` to be `completed` with a full lowercase
40- or 64-hex `delivery_commit`, `ready_for_finalization: true`, and
`workspace_root_entry.tasks_delivered: true`.

Before any index mutation, verify the entire authorized batch of recorded child delivery SHAs
and any root `root_tasks_commit` (or completed root delivery evidence) with `read-only Git` in
each `source repository`: `git cat-file -e <sha>^{commit}` verifies commit existence, not
reachability from refs. If any commit is missing, stop and stage nothing, including when the
second SHA is missing. These authorized workspace/source reads are the read-only exception to
worktree confinement; they never write sibling files or rewrite a checkout. Only after every
commit exists, pin each child `delivery commit` through the exact command
`git update-index --cacheinfo 160000,<sha>,<path>` run inside the `workspace worktree`, which
starts clean with `empty submodule directories`; the run stages only the authorized `pointer`
paths and workspace-root files, never a submodule working tree or an unrelated path. Moving a
submodule checkout after the pin is out of scope. Run only the plan's authorized cross-repository
acceptance checks read-only; do not automatically check out submodules or publish.

Keep the same root implementation record in-progress throughout finalization, preserving
`root_tasks_commit` and `started_at` on interruption. Only after final merge and owned cleanup
write `status: completed`, `completed_at` and the final workspace commit SHA, retaining the root
delivery evidence. The already-running parent/root session performs finalization directly and
does not emit an instruction to reopen itself; only a child or other repository session that is
not the already-running parent reports the bounded request below to the user. Before showing the
prompt, replace every placeholder with the actual absolute workspace root and plan directory,
quote any path argument that contains spaces (including in the command), and write it in the
user's language. The child or other session reports:

```text
Finalize the parent workspace plan <workspace-plan-directory> in the already-running parent session at <workspace-root>: invoke the coding skill for finalization-only, run ai-workflow workspace status --plan <workspace-plan-directory> against the original parent plan, require valid true with present and completed child slices, ready_for_finalization and workspace_root_entry.tasks_delivered true. Execute zero tasks, skip delivered root tasks and siblings, preserve root_tasks_commit and started_at, and verify the entire delivery-commit batch read-only before Git Operator pins any pointer.
```

## Note ownership

Cross-repository references in notes are `plain plan-ID text`; a note `never links` into
another repository's files. The `workspace root` owns the cross-repository `decision` note that
records what was decided and why, while `each repository` owns its own `delivered facts` note
covering what it actually shipped. Split the two so each side updates only its own `MEMORY.md`
and notes; the workspace root never rewrites a child's delivered facts commit.

## Completion checklist

- The change class was stated at intake and matches the delivered scope; direct
  and mechanical changes carry relevant check evidence without planning artifacts.
- A planned change without a frozen plan ended the session after Planning with
  the frozen plan path and the new-session instruction; that session created no
  worktree, implementation record or commit.
- Every assigned REQ/AC, or the direct change's stated outcome, has implementation
  and test evidence from a completed red -> green slice.
- Every slice was verified, self-checked once, and committed before the next
  slice began; commits contain only that slice's scoped changes.
- Negative cases and failure output are reported truthfully.
- Screenshots remain under the plan's `screenshot/` directory.
- Every non-mechanical change updated its relevant note and `ai-workflow notes validate` passed.
- Return `done` only when all scoped checks pass; otherwise return `blocked` or `failed` with support requests.
