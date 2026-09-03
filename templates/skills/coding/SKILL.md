---
name: coding
description: Generate, approve and execute a v2 trusted workflow from frozen plan documents.
---

# Coding

## Outcome

Generate, inspect, approve and execute one v2 manifest from one frozen plan. The local
`ai-workflow` runtime owns orchestration. Use exactly one selected native host CLI per
run; never call provider APIs or an external workflow framework.

## Preconditions

- The project is initialized and Git has a committed baseline on the target branch.
- `spec.md` and `plan.md` are frozen, share a valid plan ID and pass digest checks.
- Task files, navigation files and profile inputs are frozen before generation.
- Host is exactly one of `codex`, `claude` or `opencode`.
- The plan directory is `.ai-workflow/plans/<plan-id>`.

Run `ai-workflow plan validate --plan <directory>` before generating the artifact.
Do not silently repair frozen inputs. Return to planning or task splitting when the
requirements, task graph, host or scope must change.

## Navigation-first context

Read `MEMORY.md`, `.ai-workflow/index/navigation.json` and
`.ai-workflow/index/navigation.md` first. For each task feature, run
`ai-workflow context locate --project <absolute-project-root> --feature <id> --verify`
and read only its exact `read_order`. A missing, stale, invalid or missed locator is a
bounded File Explorer handoff, not permission to search the repository broadly.

## Plan-local artifacts

Generate with:

`ai-workflow workflow generate --plan <directory> --host <host>`

The command writes the canonical `workflow.json`, snapshots plan-local regular files
`workflow.js` and `workflow.args.json`, and validates their AST and byte digests.
Optional `--script <plan-local-file>` and `--args <plan-local-json>` inputs must be
regular files inside the canonical plan directory. Symlinks, external paths, stdin,
and start-time script or args replacement are rejected.

The manifest is the immutable capability boundary. It contains the action graph,
task dependencies, read/write scopes, concurrency groups, test commands, repair
capabilities, review rechecks and mandatory gates. Do not edit a generated manifest
to expand task, host, role, action, scope or Git authority.

## Script review

Review `workflow.js` as trusted orchestration code. Each submission uses an approved
`actionId` and a stable unique `callId`; each pipeline uses stable unique `itemKey`
values. Check the resulting action graph, dependency order, scope audit and digest
values before approval. The script chooses approved calls only; it cannot create new
capabilities or bypass host-owned gates.

## Approval and trusted boundary

Explain and validate before asking for explicit user approval:

`ai-workflow workflow explain <directory>/workflow.json`

`ai-workflow workflow validate <directory>/workflow.json --project <project>`

After confirmation, run `ai-workflow workflow approve <directory>/workflow.json`.
The v2 receipt binds the manifest, script, args, input artifacts, profile route,
sandbox policy, target branch and baseline. The trusted boundary is the host and
runtime contract, not a claim that a Worker or VM contains malicious code.

## Broker and executor

The host-native broker owns model transport and credentials. The action executor is
brokered, process-group controlled, network denied and project-write enforced. The
broker/executor split must be visible in the preflight evidence. Opaque native host
commands are protocol and audit data; they are not an in-process command allowlist.
If the required brokered sandbox capability is unavailable, fail closed.

## Execution and Git

Start only the approved artifact:

`ai-workflow run start --workflow <directory>/workflow.json --host <host> --project <project>`

v2 resources use only these paths:

- `.ai-workflow/runs/<runId>/worktrees/plan`
- `.ai-workflow/runs/<runId>/worktrees/tasks/<taskId>`
- `.ai-workflow/runs/<runId>/worktrees/repair`
- `.ai-workflow/runs/<runId>/worktrees/repair-tests/<taskId>`

Git mutation runs through the Git mutex and run queue. Git Operator owns resource
receipts, commits, merges and ownership-safe cleanup. No push, pull, fetch, rebase,
reset, clean, stash or remote mutation is allowed.

## Repair and lifecycle control

Use durable evidence for `status`, `resume`, `cancel` and `cleanup`:

`ai-workflow run status <runId> --project <project>`

`ai-workflow run resume <runId> --project <project>`

`ai-workflow run cancel <runId> --project <project>`

`ai-workflow run cleanup <runId> --project <project>`

Resume only after checkpoint, digest, baseline, resource and idempotency evidence is
reconciled. Cancel stops new scheduling and preserves evidence. Cleanup removes only
owned, clean resources. A repair may change only finding-mapped approved scope.
Each affected task gets an independent `repair-test` from the plan head after repair
merge, followed by targeted finding recheck. A second repair request pauses the run.

## Serial sessions

Coding sessions are serial. One session owns one approved plan and one run at a time.
Pass the complete prior handoff to the next session, record command output and
receipts, and do not start a later session while the current one is active. Do not
perform intermediate architecture or final implementation review in this skill.

## Completion checklist

- plan-local script and args are present, regular and digest-matched;
- manifest validation, scope audit, sandbox preflight and approval receipt pass;
- every action has stable `actionId`, `callId` and, when applicable, `itemKey` evidence;
- task closure, plan validation, reviews, repair closure, baseline and integration gates pass;
- required repair-tests and finding rechecks are closed;
- summary, receipts, tests and Git integration evidence are recorded before cleanup.
