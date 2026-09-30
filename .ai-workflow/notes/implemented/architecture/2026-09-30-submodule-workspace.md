# Agent Note: Submodule workspace delivery

Status: implemented

English | [中文](2026-09-30-submodule-workspace.zh.md)

## Problem

A change that spans several repositories had no registered boundary and no durable cross-repository flow. The single-project plan assumes one repository root: discovery scans every directory below it, tasks depend on tasks inside one graph, one implementation record covers the whole plan and one finalization commit lands in one repository. When a root composes child repositories as local git submodules, that model reads child code into the parent index, lets tasks, scopes and notes silently cross the repository boundary, and has no way to order the child deliveries or pin the commits a multi-repository change produced.

## Decision

- A git-submodule workspace root freezes one cross-repository `spec.md`/`plan.md` pair whose `workspace_repos` frontmatter names the participating repositories, their workspace-root-relative paths and the repository-level delivery order, and a `workspace.yaml` manifest assigns every task to exactly one repository.
- `.gitmodules` is the sole boundary signal: declared submodule paths are excluded from the workspace root's navigation discovery and validation, and a pre-existing workspace navigation keeps its bytes until `ai-workflow context rebuild --project <root> --write` refreshes the pair, while `context validate` reports each indexed submodule path with that instruction and a project without `.gitmodules` keeps its previous discovery and validation behavior.
- `ai-workflow workspace distribute --plan <directory>` writes a self-contained slice — the frozen planning triplets, that repository's task triplets, its filtered execution order and the `slice` manifest — into each participating repository, refuses divergent slice files before writing anything, and skips the reserved `workspace` root entry, whose tasks stay in the root plan.
- Each repository implements its slice in its own session with its own worktree, validation, implementation record and delivery commit, and its tasks never depend on a task in another repository.
- `ai-workflow workspace status --plan <directory>` reports read-only, in delivery order and without writing, each repository's slice presence, implementation-record state and delivery commit, plus the next repository and whether all slices are complete.
- After every slice completes, the root verifies each recorded delivery commit with read-only Git in its source repository and pins each affected submodule inside the workspace worktree with `git update-index --cacheinfo 160000,<sha>,<path>`, staging only the authorized pointer paths and workspace-root files. The workspace root owns the cross-repository decision note, each repository owns the note covering the facts it delivered, and cross-repository references stay plain plan-ID text.

## Alternatives considered

- **Detect multi-repository topologies other than registered submodules.** Declined: only `.gitmodules` provides an explicit boundary signal; inferring participation from directory layout, nested checkouts or a scan would treat unrelated embedded trees as participants and leave the boundary implicit.
- **Let tasks depend on tasks in another repository.** Declined: task-level cross-repository dependencies would couple one slice's execution to another repository's worktree, record and commit order, so scheduling stays at repository granularity in the declared `workspace_repos` order and no task ever depends on another repository.
- **Index child code in the workspace navigation.** Declined: child state belongs to the child's own navigation; indexing it in the root would give both indexes overlapping ownership of the same files and symbols and let either side's refresh invalidate the other.
- **Automate or remotely orchestrate the child sessions.** Declined: the workflow runs local sessions, so distribution hands a slice to a repository and that repository's own session implements it; an orchestrator that started, scheduled or drove remote sessions would add an unsupported runtime surface and hide the repository boundary.
- **Mutate Git during distribution or status.** Declined: distribution writes files and status inspects state, so both stay repeatable and side-effect-free; a hidden commit, checkout or branch would make them non-idempotent and bypass the Git Operator entry point, while read-only Git in status and delivery-commit verification is the explicit exception the project contract declares.
- **Migrate legacy plans or navigations.** Declined: a workspace navigation written before the boundary existed is refreshed only through `ai-workflow context rebuild --write`, and a legacy plan without `workspace_repos` keeps its bytes and its previous behavior; an automatic migration would rewrite frozen or indexed content the user has not reviewed.

## Consequences

- Slices are gitignored local artifacts under each repository's `.ai-workflow/plans/<planId>/`, exactly like an ordinary frozen plan, so the existing ignored-state materialization rule applies unchanged inside each participating repository.
- Delivery commits are pinned through the workspace worktree: the only Git mutation in the workspace flow is the finalization pointer commit performed by Git Operator, and commit verification compares each resulting pointer with the recorded delivery SHA.
- Moving submodule checkouts after the pin is out of scope, and the pointer commit references locally available delivery commits only, so remote operations stay out of scope.
- Pre-existing workspace navigations stay byte-unchanged until the explicit rebuild, and a project without `.gitmodules` keeps its discovery, validation and commands unchanged; the workspace declaration, the task `repo` field, `workspace.yaml` and the two workspace commands are additive.
- No active note is superseded in full or in part: [the worktree policy record](../process/2026-09-14-project-local-worktree-policy.md) and [the ignored-state sharing record](../process/2026-09-14-share-ignored-state-into-worktree.md) remain current because the workspace flow operates inside worktrees and reads the workspace tree only read-only, while [the task execution order record](../process/2026-09-25-task-execution-order.md) and [the implementation record](../process/2026-09-22-plan-implementation-record.md) keep their rules per repository; this record only adds the cross-repository layer.
