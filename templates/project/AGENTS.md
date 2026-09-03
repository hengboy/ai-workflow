# Project agent constraints

- All coding commands operate on v2 `workflow.json` manifests generated from frozen plan inputs. Do not introduce a v1 workflow or run record.
- File Explorer performs bounded fallback discovery only. It may read and search authorized paths, but must not modify `MEMORY.md`, navigation indexes or other files.
- Documentation Maintainer owns explicitly scoped indexes, `MEMORY.md` and non-code/non-plan documentation; it must not modify source, tests, schemas or frozen plans.
- Known work starts by reading `MEMORY.md`, `.ai-workflow/index/navigation.json` and `.ai-workflow/index/navigation.md`, then using `ai-workflow context locate`.
- Action scripts use approved `actionId`, stable `callId` and stable pipeline `itemKey` values. They cannot expand task, host, role, scope or gate authority.
- The host-native broker owns model transport and credentials. The brokered executor enforces process groups, denied executor network and project write scope; this is a trusted boundary, not a malicious-code security sandbox.
- Scope audit evidence must precede action admission. Git Operator exclusively executes Git and owns the Git mutex, run queue, resource receipts, worktrees, commits and merges.
- v2 worktrees are `.ai-workflow/runs/<runId>/worktrees/plan`, `.ai-workflow/runs/<runId>/worktrees/tasks/<taskId>`, `.ai-workflow/runs/<runId>/worktrees/repair` and `.ai-workflow/runs/<runId>/worktrees/repair-tests/<taskId>`.
- Repair-test actions use the plan head after repair merge and require targeted finding rechecks. They do not authorize a second repair round.
- All other roles stay inside packet read/write scopes and allowed commands. Screenshots belong in `.ai-workflow/plans/<planId>/screenshot/`.
- Sessions are serial: pass the complete prior handoff before starting the next session, and keep command output and durable receipts with the run.
