# Workspace execution reference

This required reference supplies parent, root-delivery, independent slice and
finalization procedures. Apply it with `SKILL.md`'s shared gates and record lifecycle.

## Activation and preflight

Parent activation requires the main skill's frozen non-root participant matched
to `.gitmodules`; the ordinary, non-participating and root-only routes stay
unchanged. Refuse claimed workspaces with absent, mismatched or escaped
declarations; no fallback runs child tasks in the root.

Before creating a worktree or implementation record, confirm the delivery gate with
`ai-workflow workspace status --plan <directory>` against the original absolute
parent plan directory, after approved preparation if needed. Require `valid: true`,
validated frozen `tasks/execution-order.yaml` and every child slice `present`.
Status is filesystem-only; preflight validates participant names/paths, parent plan,
slices, each repository's contract, scopes and schedule with read-only Git. Refuse
wrong declarations, ancestor Git roots, detached/dirty sources, escaped or
nested-submodule write scopes, malformed records, invalid schedules and
missing/divergent slices before any coding worktree or record.

If splitting is needed, direct to the parent root for plan-to-tasks with the absolute
parent plan directory; parent Coding uses Approved preparation below. For existing
split artifacts, request repair of the named divergence and a rerun of
`ai-workflow workspace distribute --plan <directory>` against that same directory.
Never repair frozen inputs in coding.

## Approved preparation

For a frozen child-participating plan with no task set or incomplete slices, the parent
Coding session runs approved preparation as its bounded recovery path; a plan whose
planning session already completed the chain does not need it. Before any
implementation state, parent Coding runs approved preparation and
distribution against the absolute parent plan. With no task set, invoke
`plan-to-tasks` as the `preparation procedure`: show the full approval preview,
obtain approval, write complete task triplets/pair records, schedule and
`workspace.yaml`, run `ai-workflow plan validate --plan <directory>`, then
`ai-workflow workspace distribute --plan <directory>`. Distribution writes slices
only after read-only preconditions pass; preparation returns control to the same
parent Coding session to continue implementation. The task set freezes only after
the distribution succeeded for every participating repository with
`ai-workflow workspace status --plan <directory>` valid and every participating slice
present, and no implementation state begins while the task set is unfrozen. Reuse valid
split artifacts byte-unchanged; partial/invalid tasks or divergent slices stop with a
repair request, never regeneration. Declining approval creates no tasks, no slices, no
worktrees and no implementation records. Standalone plan-to-tasks ends after its own handoff.

For a plan whose planning session already completed the chain, the slices are present:
verify the delivery gate (`ai-workflow workspace status --plan <directory>` with every
participating slice present) before any worktree or implementation record, implement
without repeating the preparation, and start no implementation state while the task set
is unfrozen.

## Phase dispatch and delivery barriers

The primary parent session directly dispatches native leaf agents as the only
dispatcher: no nested coordinator, no splitter sub-agent, no child host process,
no sibling session, scheduler service or provider API executor, and no remote sessions.
This route never requires a manual child session.

The original parent `tasks/execution-order.yaml` is the only global task schedule.
The primary inspects the current-phase task bodies and must not eagerly read future
tasks or child-manifest bodies.
Apply the main scheduling rules: file order, concurrent independent tasks with
Test first, the whole phase awaited and verified, then serial scoped task commits
through Git Operator in listed order. Shared build contention permits serialization
within the phase only. No missing-schedule serial fallback or recomputation from
`depends_on` or filtered slice phases.

After a repository's last task phase, complete its per-repository delivery review
and repository delivery gate, record delivered facts and capture its delivery commit
before dependent repositories advance. A repository may span global phases; its
filtered slice schedule cannot run ahead of the active parent phase.

## Repository worktrees and commits

Git Operator creates one run-owned worktree per active repository at
`<source-root>/.worktrees/<planId>` on branch `ai-workflow/<planId>` and verifies
its actual Git common directory; directory names alone prove no identity.
The parent worktree is not a container for child implementation: submodule
directories stay empty; child edits stay in its own worktree. Materialize each
repository's entire ignored state under the main policy, excluding `.worktrees/`.
Verify every serial task commit's exact write scope, parentage and both rename
endpoints. A genuinely unchanged task records exact verified HEAD evidence without
an empty commit. Integrate delivery non-fast-forward and clean up only run-owned
worktrees/branches, preserving unrelated user state.

## Packet contract

Every packet carries exact absolute parent plan/root, source repository, local
slice plan, coding worktree, phase/task ID, assigned REQ/AC, task goal, permitted
commands, output paths and upstream delivery evidence; the referenced frozen task supplies
the canonical exact read/write scopes rather than repeating both the relative and resolved
scope lists.
Every command uses an explicit workdir and every packet path is an absolute path, never
resolved against inherited parent cwd. Each leaf explicitly
reads that repository's own `.ai-workflow/AGENTS.md`, `MEMORY.md`,
`.ai-workflow/index/navigation.json` and `.ai-workflow/index/navigation.md`, except
Spec Review, which reads only the repository contract as procedural authority plus its
frozen requirement references, immutable commit range, neutral routing metadata and raw
evidence paths and never receives plan or task files, notes as process acceptance requirements or accepted results.
A native permission denial is a blocker, never permission to bypass the host or
create a different worktree.

Return envelopes keep the delegated Markdown shape with `### Status`, `### Summary`,
`### Evidence` and `### Support Requests` and add upper bounds: an `### Evidence`
entry carries the absolute path of the produced artifact or an explicit report
reference plus at most one sentence of conclusion, with no embedded diffs, logs,
JSON bodies or code blocks. Large outputs belong in
`<plan-directory>/reports/<taskId>.log`, a gitignored path that is never committed. A fresh
read-only digest the primary requests is read-only, grants no write permission, never reruns
a completed side effect and never claims to remove already received content.

## Review and checkpoint record

Delivery review covers that repository's tasks; the separate finalization review
does not re-review delivered tasks. Serial task commits supply each split repository
range, an unsplit repository commits its checked implementation before review, and a
checked repair or finalization pointer change is committed before its own review.
Those commits imply no review PASS and no integration authorization, and after an
accepted review no further content-changing or empty commit before integration may
drift the reviewed HEAD. Both axes receive the same immutable HEAD with separate permitted payloads, and
Spec Review receives only requirement references and the raw commit range, never plan
or task files, implementation narrative, test execution reports, logs or pass claims,
earlier findings or verdicts. Its raw range arrives only through Git Operator's packet-authorized
gitignored evidence file paths and verified full SHAs, because the reviewer has only
`read` and cannot read Git objects. A recheck is one fresh affected-axis batch; Spec
Review receives only affected requirement references plus the updated range and
repair code scope, and finalization uses only its own repository-local base and scope.
Initial implementation and repair commits exist before Spec dispatch, and the
workspace pointer commit stays finalization-only. Findings requiring changes in a
delivered child need out-of-scope support or a new plan; never reopen that child.

The single `implementation.yaml` follows the main lifecycle, with no extra run
record, ledger or manifest. Workspace fields are:

| Field | Evidence |
| --- | --- |
| `execution` | Anchor with `purpose` (`tasks` versus `finalization`), canonical `source_root`, `repository`, absolute `worktree`, `branch`, `target_branch` and repository-local `base_commit`. |
| `task_checkpoints` | `kind: commit` with the task's full commit SHA after scope/parentage/rename checks, or `kind: no-change` with the exact verified HEAD SHA. |
| `reviewed_commit` | Written only after the aggregate repair, fresh checks, any targeted recheck and closure are accepted; a purpose-scoped exact reviewed HEAD that cannot be reused for another purpose or a changed HEAD. A different purpose does not authorize it again. |

Only the primary writes checkpoints, after Git evidence, through filesystem-only
`ai-workflow workspace checkpoint --plan <directory> --repo <name>` into that
repository's single record. It accepts exactly one `start`, `task`, `reviewed`,
`delivered` or `finalized` JSON event on stdin. Refuse unknown fields, wrong types,
wrong plan/repository, unauthorized task IDs, contradictory duplicates, invalid
transitions or malformed full SHAs before writing. Identical repeats are idempotent;
refusal leaves the prior record byte-unchanged.

## Workspace root sessions

For parent `workspace.yaml` with `role: workspace` and a non-root participant,
apply preflight's delivery gate before any worktree or record and require the
current project root to equal the absolute `workspace_root`. Execute root delivery
only when `next_repository` is `workspace` and
`workspace_root_entry.tasks_delivered` is false; otherwise hand off the reported
next repository or finalize when ready.

Select only `task.repo: workspace` tasks. Filter parent phases in memory, preserving
file order and removing empty phases; never edit `tasks/execution-order.yaml` or
recompute the DAG. Execute only these root tasks in the root worktree with normal
validation/review, never siblings; parent orchestration retains its global schedule.
After passing, merge, perform owned cleanup and apply the main record table's root
delivery row. Report the root SHA, rerun parent status and hand off `next_repository`.

When `tasks_delivered` is true, skip delivered root tasks and siblings.
Finalization-only executes zero tasks, never reruns root reviews and uses the
finalization gate below. For no root tasks, apply the main record table's implicit delivery.

## Slice sessions

Read the independent slice manifest `workspace.yaml` before any other slice step.
Run parent status against the original absolute parent plan; require `valid: true`,
this repository as `next_repository` and its slice `present`. The absolute current
project directory must equal reported workspace root plus declared repository path.
A mismatch refuses before any branch, worktree or implementation record, with bounded
support naming expected/actual repositories. Invalid status, wrong delivery position
or missing/divergent slices likewise refuse before a worktree or record.

With no slice `workspace.yaml` in a participating repository's plan directory, report
the missing manifest and stop before creating a worktree or implementation record.
Direct to a parent-root session to rerun
`ai-workflow workspace distribute --plan <directory>` with the same absolute parent
workspace plan directory as the repair.

A matching session implements only its slice tasks inside that repository, including
edits, notes and records; never edit siblings or the workspace root. Complete with
`ai-workflow plan validate` for the slice, `ai-workflow notes validate` for local
notes and a same-change `MEMORY.md` update. Record/report its delivery commit SHA
to the workspace orchestrator; the root pins it later.

Rerun `ai-workflow workspace status --plan <directory>` against the absolute parent
plan, then hand off the next repository, path, session and copyable prompt in frozen
delivery order: workdir `<repository-root>`, local plan `<repository-plan-directory>`,
original parent `<workspace-plan-directory>`. `next_repository: workspace` hands off
a root delivery session for pending root tasks; null with `ready_for_finalization` and
`workspace_root_entry.tasks_delivered` true hands off a new root finalization session.
A child never finalizes by itself.

## Recovery

Automatic resume is limited to a clean, fully checkpointed phase boundary or a
verified repository delivery boundary. Verify recorded SHAs, history, scopes,
worktree registration, target refs and ownership. Dirty partial-phase residue,
commit-without-checkpoint gaps, unknown future-phase progress, uncertain review
results, contradictory records or unrelated target drift stop with bounded support
or recovery instead of redispatch. Never blindly redispatch recorded tasks.
Lost merge completion requires exact reviewed head, target baseline, expected merge
parentage and owned-cleanup evidence; otherwise stop. Never adopt a different-run
worktree; simultaneous primaries over one run are unsupported.

For a workspace execution with checkpoint records (parent orchestration and
slices), the primary must not perform an active rebuild of its context except at a
clean, fully checkpointed phase boundary or a verified repository delivery boundary.
It re-derives state from the frozen files (`tasks/execution-order.yaml`, task files,
each repository's `implementation.yaml` and the `workspace status` projection),
never from conversation history. Before continuing, verify that recorded checkpoint
SHAs match Git objects through read-only checks, that `workspace status` shows no
drift and that no commit lacks a checkpoint; only then does it continue.

Discarding context at a dirty or partial phase, a commit-without-checkpoint gap or
unknown progress is prohibited. When context pressure appears mid-phase, the primary
first completes in-flight tasks to the nearest verified boundary (validation,
commit, checkpoint) and restarts there; if it cannot reach a clean boundary it
reports `blocked` with bounded support. A resumed session follows the frozen
schedule and never recomputes the DAG or skips tasks. Ordinary split or unsplit plans
keep the existing fresh-session recovery with no active-rebuild rule.

## Workspace finalization

`all slices are completed` is insufficient. Run parent
`ai-workflow workspace status --plan <directory>` using absolute
`<workspace-plan-directory>`. Require `valid: true` (plan, tasks, schedule and
manifest pass distribution's validation), every child slice `present` and record
`completed` with matching `plan_id` and full lowercase 40- or 64-hex
`delivery_commit`, `ready_for_finalization: true` and
`workspace_root_entry.tasks_delivered: true`.

Before any index mutation, Git Operator verifies the entire authorized batch of
child delivery SHAs and any `root_tasks_commit` (or completed root delivery evidence)
with read-only Git in each source repository: `git cat-file -e <sha>^{commit}` checks
existence, not reachability from refs. Any missing commit stops and stages nothing; a missing
second SHA must not leave the first pointer staged. These authorized workspace/source
reads are the read-only exception to worktree confinement, with no sibling writes
or checkout rewrites.

After every commit exists, pin the exact final gitlink tree using
`git update-index --cacheinfo 160000,<sha>,<path>` inside the clean workspace worktree
with empty submodule directories. The run stages only authorized pointer paths and
workspace-root files, never submodule working trees or unrelated paths. Moving a
submodule checkout after pinning is out of scope; run only the plan's authorized
cross-repository acceptance checks read-only, without automatic checkout or publishing.
Complete the separate finalization review before merge/owned cleanup, then apply
the main record table, including read-only idempotent completed reentry.

After all children are delivered and root tasks delivered, same-parent finalization
runs directly in the correct already-running parent/root session without reopening
itself. Only another repository session reports this bounded request; substitute
actual absolute paths, quote arguments with spaces (including command arguments),
and use the user's language:

```text
Finalize the parent workspace plan <workspace-plan-directory> in the already-running parent session at <workspace-root>: invoke the coding skill for finalization-only, run ai-workflow workspace status --plan <workspace-plan-directory> against the original parent plan, require valid true with present and completed child slices, ready_for_finalization and workspace_root_entry.tasks_delivered true. Execute zero tasks, skip delivered root tasks and siblings, preserve root_tasks_commit and started_at, and verify the entire delivery-commit batch read-only before Git Operator pins any pointer.
```

## Note ownership

Cross-repository references stay plain plan-ID text; a note never links into another
repository's files. The workspace root owns the decision (what/why); each repository
owns its delivered facts (what shipped). Each updates only its own `MEMORY.md` and
notes; the root never rewrites a child's delivered facts commit. Apply main Note
Maintenance, including its scoped reads and mechanical/local-edit exemptions.
