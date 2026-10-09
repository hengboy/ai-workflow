# Parent workspace execution reference

This reference details the parent workspace execution route summarized in `SKILL.md`.
It applies only to a frozen plan that declares at least one participating non-root
repository matched to the current root's `.gitmodules`.

## Activation and preflight

This activation requires both a matching `.gitmodules` and a participating frozen plan;
a project with child repositories but an ordinary or root-only plan keeps its usual
route. Preflight validates every participant name and path, the original parent
plan, each slice, each repository's own contract, task scopes and the frozen
schedule with read-only Git. The preflight refuses a missing or divergent slice, a
wrong declaration, an ancestor Git root, a detached or dirty source, an escaped or
nested-submodule write scope, a malformed record or an invalid schedule, and it
creates no new coding worktree or implementation record. A claimed child repository
that cannot be matched is a refusal, not a fallback to running its tasks in the root.
Clarifications may reuse shared leaf handling, but no ordinary packet is burdened
with workspace-only fields.

## Phase dispatch and delivery barriers

The original parent `tasks/execution-order.yaml` is the only global task schedule.
Process its phases in file order, dispatch the independent tasks of the current
phase concurrently, and await and verify the whole phase before any serial task
commit; a whole phase that is awaited and verified prevents one task's success from
standing in for the phase. Contended shared build outputs may be serialized within
the phase without changing the frozen order. Neither a recomputed DAG nor a slice's
filtered phase numbering grants dispatch authority.

After a repository's last task phase, complete its review and delivery gate as a
delivery barrier before a dependent repository advances; a repository may span
several global phases, and its filtered slice schedule must not run ahead of the
active parent phase. The primary records the delivered facts and releases dependents
only after the delivery commit is captured.

## Repository worktrees and commits

Each active repository owns exactly one run-owned worktree per active repository at
`<source-root>/.worktrees/<planId>` on branch `ai-workflow/<planId>`, and the parent
worktree is not a container for child implementation: its submodule directories stay
empty. Git Operator creates and owns that worktree, verifies the repository's actual
Git common directory so a matching directory name does not prove identity, and
materializes the repository's ignored state. Scoped task commits are checked for
exact parentage and both endpoints of a rename, and every commit contains only the
task's exact write scope. A genuinely unchanged task records verified no-change
evidence against an exact HEAD and creates no empty commit. Delivery integration is
non-fast-forward, and only run-owned worktrees and branches are cleaned up.

## Packet contract

Every packet states the exact absolute parent plan/root, the source repository, the
local slice plan, the coding worktree, the phase/task identifier, the assigned
REQ/AC, the relative and resolved read/write scope, the permitted commands, the
output paths and the upstream delivery evidence. Every command runs with an explicit
workdir, and every path is an absolute path rather than one inherited from the
parent's cwd. A leaf explicitly reads that repository's own `.ai-workflow/AGENTS.md`,
`MEMORY.md` and navigation. A native permission denial is a blocker, not permission
to create a different worktree or bypass the host.

## Review and checkpoint record

After a repository's last task phase the primary dispatches a per-repository delivery
review and repository delivery gate for that repository's task scope; finalization
later has its own separate finalization review and does not re-review delivered
tasks. Resolve findings through the existing repair-selection gate and one bounded
aggregate repair.

Each repository keeps the single `implementation.yaml` record; there is no extra run
record, ledger or manifest, and no new top-level status beyond `in-progress` and
`completed`. The record carries an `execution` anchor with its `purpose` (`tasks`
versus `finalization`), canonical `source_root`, `repository`, absolute `worktree`,
`branch`, `target_branch` and repository-local `base_commit`. Typed `task_checkpoints`
distinguish a writing task that stores `kind: commit` with its full commit SHA from a
verified unchanged task that stores `kind: no-change` with the exact HEAD SHA. A
purpose-scoped `reviewed_commit` records the exact reviewed HEAD and cannot be reused
for another purpose or a changed HEAD; a different purpose does not authorize it again.

Write checkpoints only through the filesystem-only command
`ai-workflow workspace checkpoint --plan <directory> --repo <name>`, called by the
primary only after the required Git evidence. Identical repeated events are
idempotent, and a refusal leaves the prior record byte-unchanged.

## Recovery

The supported recovery boundary is automatic resume only at a clean, fully checkpointed phase boundary or
a verified repository delivery boundary. On entry, verify recorded SHAs, history,
scopes, worktree registration, target refs and ownership before trusting progress.
A dirty partial phase, a commit-without-checkpoint gap, unknown future-phase progress,
uncertain review results or a contradictory record stops with a bounded support
request instead of redispatch. Recorded tasks are identified and not blindly
dispatched again. Reconstructing a lost merge completion requires an exact reviewed
head, the target baseline, expected merge parentage and owned-cleanup evidence;
otherwise it stops. An occupied different-run worktree is never adopted, and
simultaneous primaries over the same run are unsupported.

## Finalization

After all children are delivered and the root tasks are delivered, the same-parent
session finalizes directly; it does not reopen itself in a new root session. Git
Operator verifies the entire authorized batch of delivery commits read-only in their
source repositories before any index mutation, then pins the exact finalized gitlink
tree, and a completed reentry is read-only and idempotent. A finalization review
finding that would require changes in an already delivered child is an out-of-scope
support request or a new plan, not permission to reopen that child.

## Non-goals

- There is no nested coordinator and no splitter sub-agent: the primary parent
  session is the only dispatcher and directly dispatches native leaf agents.
- There are no remote sessions, no provider API executor and no separate child
  host process.
- No fallback that runs child tasks in the root: a claimed workspace that cannot be
  matched to `.gitmodules` is refused rather than silently executed as a
  single-repository task set.
- No change to ordinary or root-only single-repository worktree, task ordering,
  review, implementation-record or completion semantics.
