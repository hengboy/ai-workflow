---
name: planning
description: Freeze a reviewed spec.md and plan.md for a new or ambiguous feature; small fixes are implemented directly.
---

# Planning

## When to use

Planning is only for a planned change: a new feature, unclear or contested requirements, more than one materially different design, or a change to a public interface, persistent format, cross-module or cross-stack behavior, migration, compatibility or the project contract. A small requirement, feature adjustment or defect fix with clear, bounded intent is implemented directly and must not enter Planning; never use Planning to restate a request whose scope is already settled. Ask the user only when the request cannot be classified.

## Outcome

Turn an idea into an explicitly confirmed, independently reviewable `spec.md` and `plan.md`. Use only the current host's native skill and native sub-agents. Do not invoke a coding workflow, an external orchestrator, or provider APIs.

## Required inputs

- Project root and current product context.
- The user's goal or problem statement.
- Existing constraints supplied by the user or exact paths returned by File Explorer.
- A proposed English slug; normalize it to `YYYYMMDD-english-slug` only after scope is stable.

If the project root or goal is missing, ask for that information before drafting.

## Navigation-first context

Before repository context work, directly read the fixed context: `.ai-workflow/AGENTS.md`, `MEMORY.md`, `.ai-workflow/index/navigation.json` and `.ai-workflow/index/navigation.md`. The contract governs the whole project and every participating agent; record absent `MEMORY.md` as a legal state.

For a known feature run `ai-workflow context locate --project <absolute-project-root> --feature <id> --verify`, then read only its exact `read_order`. The root argument is the normalized project directory path, never its directory name. Do not search. For `missing_index`, `miss`, `stale` or `invalid`, request File Explorer with the original goal, status/reason and authorized module roots.

Each task's `read_scope` is fixed context plus exact locator paths and exact bounded paths for relevant notes/governance; it must not contain `src/`, `tests/` or the project root.

## Work-boundary synchronization

At skill session start, invoke exactly once for the actual project root:
`ai-workflow sync-hook --host <current-host> --phase --project <actual-root>`.
Later steps, phases and native host events reuse that root's stored result with no source request; a missing, corrupt or unreadable check allows with visible no-freshness context.

The raw gate JSON has top-level `decision` (`allow`, `deny`, `skip`) and nested `report` fields `status`, `verified`, `proceed` (no report for `skip` or actor exemption). It exits 0 even on denial: `deny` or `report.status` of `conflict`/`failed` stops the phase; warnings proceed visibly without claiming freshness; `skip` means no adoption. Manual `ai-workflow sync [project]` returns a `SyncReport` with those report fields and no `decision`. The installed stdin form `ai-workflow sync-hook --host <host>` requires the native JSON payload; never run it by hand without that payload.

After a safe patch changes the contract or owned workflow rules, re-read updated `.ai-workflow/AGENTS.md` before ordinary work. Frozen `spec.md`, `plan.md` and task files are never synchronization input; contradictory new authority stops the phase with a bounded support request, never a broader frozen scope.

## Workspace planning

When the project root declares submodules in its `.gitmodules` file, treat that root as a workspace root. Detect participation from that declaration only; never infer it from directory layout, nested checkouts or a scan.

A workspace plan names the participating repositories and their dependency order. Confirm both as clarification questions, each in the numbered clarification prompt format: which declared repositories participate in this change, and which participating repository depends on which other participant. Fix the dependency order before drafting, because it sets the repository delivery order.

Read each child's context through that child's own root: that repository's `own project contract` (`.ai-workflow/AGENTS.md`), its `MEMORY.md`, and `navigation through that repository's root`. Never substitute the workspace root's contract for a child's; each participating repository's own project contract governs that repository.

Freeze `workspace_repos` and the `per-repository delivery boundary` using the mandatory plan template below. Its Workspace repositories and Workspace finalization sections define repository fields, root-prefix delivery, schedule constraints, cross-repository evidence and finalization authority; preserve those constraints in the plan.

The workflow `stops before freezing` when a participating child `is not an initialized ai-workflow project` (missing `.ai-workflow/AGENTS.md`). Report the offending child and the repair `ai-workflow init <child> --upgrade`; never freeze a workspace plan whose participating child is uninitialized.

Planning `schedules each repository's note` and `MEMORY.md` work `in that repository`, through its own notes and memory. Planning never distributes or writes a slice; the Completion checklist owns the split and session handoff and automatically invokes the `plan-to-tasks` preparation procedure for a child-participating workspace plan after the frozen pair passes `plan validate`.

## Clarification loop

Ask the highest-priority clarifying question per turn: choose the unanswered inventory item whose ambiguity changes the most downstream work. Consider measurable goals, non-goals, actors and primary/alternate scenarios, functional requirements, AC/evidence, compatibility/performance/privacy/platform constraints, invalid inputs/failures/cancellation/recovery, validation layers and RED criteria.

Apply a business-relevance gate before asking any question:

- Ask only about an ambiguity that can change the product goal, actor or permission, core user workflow, domain rule or data meaning, externally observable acceptance behavior, or a user-mandated compatibility, privacy, performance or failure constraint.
- Do not ask about naming, wording, formatting, file locations, internal API shape, framework or library choice, code organization, test style, or routine UI details unless the user explicitly constrained them or the choice changes core business behavior.
- Resolve low-impact and implementation-level choices yourself using the repository's conventions and the simplest reasonable default. Record material assumptions in the working inventory instead of turning them into questions.
- Do not present options merely to outsource an engineering decision. Present options only when the alternatives represent materially different business outcomes or user-visible behavior, and explain the trade-off for each.
- For every candidate question, first check: "Can this be decided from the user's goal, repository context or normal engineering judgment?" and "Would another answer change core business behavior or acceptance evidence?" If the answer is no, decide it and continue.
- If no unanswered ambiguity passes this gate, stop asking questions and show the complete confirmation preview.

Format every clarification prompt as a numbered requirement question. Start each question with `问题 N：` (for example, `问题 1：...`, then `问题 2：...`) and increase N monotonically across the entire clarification loop, including across turns; never reset or reuse a question number. Number its options `1、2、3、4` in display order. Every option must include a short explanation of its consequences or trade-offs. Mark the recommended option prominently (for example, `**推荐：1、...**`) and explain why it is recommended. Never present an unexplained or unnumbered option.

Do not bundle unrelated questions. Reflect the answer into the working inventory and surface contradictions immediately.

## Requirement quality checklist

Before requesting confirmation, assemble the complete goals, non-goals, REQ/AC inventory, scenarios, constraints, error boundaries and verification matrix. Verify that:

- each requirement and AC has one stable, continuous `REQ-###` or `AC-###` identifier; each REQ maps to at least one AC and every AC names observable behavior;
- behavior uses Given/When/Then where sequence or state matters;
- errors include boundary values and at least one counterexample;
- non-goals prevent likely scope expansion;
- verification identifies unit, integration, behavior, smoke or manual evidence;
- compatibility and rollback expectations are explicit;
- no implementation choice is disguised as a requirement unless the user mandated it.

## Step granularity

- Split by cohesive, independently verifiable outcomes, not by file, layer or mechanical edit; keep tightly related behavior and its tests in one step.
- Order steps by dependency and priority so upstream, higher-priority outcomes land first and the critical path stays short.
- Never over-decompose: every step adds a delegation, a verification and a commit, so merge work that shares one outcome, one responsible role and one validation command into one step.

## Confirmation gate

Show that complete inventory in one preview and ask for explicit approval. Until approval:

- do not create the plan directory;
- do not write or overwrite `spec.md` or `plan.md`;
- do not freeze a digest;
- do not create task or workflow files.

Material user changes invalidate the preview and require a new complete preview.

## Document contract

The six-file deliverable lives at `.ai-workflow/plans/<YYYYMMDD-english-slug>/`:

- `spec.md` + `spec.zh.md` + `spec.i18n.yaml`: goal, non-goals, scenarios, continuous REQ/AC, Given/When/Then evidence, RED criteria, boundary counterexamples and validation layers.
- `plan.md` + `plan.zh.md` + `plan.i18n.yaml`: every REQ/AC mapping, implementation order, exact or bounded read/write paths, checks, compatibility, rollback and responsible native role.

Each document is a complete bilingual triplet. Only English carries YAML frontmatter (`plan_id`, `status: frozen`, `created_at`, nullable `supersedes`, `requirement_count`, `acceptance_criteria_count`, `digest`) and supplies machine REQ/AC IDs, counts and digests. The Chinese `.zh.md` has no frontmatter; it starts with the same English title followed by `[English](<doc>.md) | 中文`. English follows its title with `English | [中文](<doc>.zh.md)`. Mirror headings, structure, tables, lists and link targets; only prose differs. The `.i18n.yaml` is a consistency record, never a third prose side.

Plan steps use `Responsible role`; `plan.md` itself does not require a
`surface` attribute. Surface routing is added only to generated task files.

Before drafting, read [the specification template](references/spec.md), [the implementation plan template](references/plan.md) and [the frozen-plan digest protocol](references/digest.md). Preserve their contracts; replace illustrative content with approved requirements and repository-specific evidence. A changed frozen requirement creates a new plan ID; never edit a frozen plan in place.

## Draft and review workflow

Draft, review and repair happen before final approval; freezing happens only after it.

1. Draft both documents in memory with all sides defined above. You must not write drafts, snapshots or other planning artifacts to a system temporary directory or any path outside the plan directory. The primary reads existing `MEMORY.md` directly while drafting and never dispatches a routine Standards Review.
2. Run one full Spec Review before presenting the final confirmation preview, with exactly one dispatch, to check coverage, testability, contradictions, read/write bounds, sequencing, rollback and role assignment.
3. The primary automatically repairs every in-scope finding within the settled intent, without asking which findings to fix. If a repair affects a finding, dispatch at most one targeted recheck of only the affected findings with the original labels, the repair diff and fresh evidence; never start a second full review. A material user change after review invalidates this reviewed draft: stop its freeze and establish a new planning boundary and Plan ID instead of reusing stale review evidence or reviewing the same boundary again.
4. Only after the draft review and any in-scope repair or targeted recheck are accepted, show the complete final inventory in one preview and obtain explicit approval.

After approval:

5. Materialize `spec.md` and `plan.md` directly in `.ai-workflow/plans/<planId>/`; if SHA-256 calculation requires filesystem input, re-read them there for the digest and update or replace those same files there before freezing. Finalize both language sides, set each English `digest: ""`, calculate and fill it using the mandatory digest protocol, and write all six frozen files atomically in the plan directory. A missing `.zh.md` or `.i18n.yaml` is an incomplete triplet; never freeze either English document without both companions.
6. Re-read all six files; verify shared plan ID, counts, frozen status and content digests.
7. Record the pair with `ai-workflow plan pairing --plan <directory> --write spec plan`, then run `ai-workflow plan validate --plan <directory>`. This is a hard completion gate: repair missing companions, wrong switchers, structure mismatches or stale digests, re-record and revalidate until it passes. No completion or Plan-to-tasks/Coding handoff while any triplet is incomplete.

The planning primary owns writes; Spec Review is read-only. Planning artifacts are gitignored local, untracked files. Planning creates no Git commit: do not dispatch Git Operator and do not stage or commit any planning artifact.

## Agent Notes

Planning schedules note work; the landing change owns its record and lifecycle transition. Read `.ai-workflow/notes/AGENTS.md` and `.ai-workflow/notes/README.md`, the single source for note format, lifecycle, supersession and archive governance. `MEMORY.md` records current standards (how), notes record why; keep them consistent in the same change without restating governance here.

Schedule note work when the change lands a lasting decision whose rationale code, tests and existing documentation cannot adequately explain; then the `plan.md` must contain an explicit step that adds or updates the relevant note, and the plan must align `MEMORY.md` with that note in the same change. Local, mechanical, UI, copy and formatting changes without such lasting rationale are exempt. Major unimplemented work is scheduled as `proposed`; a change that lands a decision moves its note to `implemented` and rewrites the body to delivered facts.

## Completion checklist

- The user approved the final full inventory, including any repaired review findings.
- Every plan that lands a lasting decision whose rationale code, tests and existing documentation cannot adequately explain schedules its note work and aligns `MEMORY.md`; local, mechanical, UI, copy and formatting changes without such lasting rationale are exempt.
- The six-file contract and single-review workflow are complete: shared plan ID/counts, mirrored structure, matching English digests, recorded pairs and passing `ai-workflow plan validate --plan <directory>`.
- Planning ends at the frozen plan and never starts implementation: report the absolute project or workspace root, the frozen plan directory and the `plan validate` result, then route by `workspace_repos`.
  - A plan declaring at least one non-root participating repository must be split by plan-to-tasks before implementation. Immediately after the frozen pair passes `ai-workflow plan validate --plan <directory>`, the Completion checklist automatically invokes the `plan-to-tasks` preparation procedure in this session with the absolute frozen plan directory: show the complete approval preview, obtain explicit approval, write the task triplets and their pair records, `tasks/execution-order.yaml` and `workspace.yaml`, pass the final `ai-workflow plan validate --plan <directory>`, then run `ai-workflow workspace distribute --plan <directory>` for every participating repository and require `ai-workflow workspace status --plan <directory>` to report valid with every participating slice present. The task set is frozen only after that full distribution; report each participant's name, path, `depends_on` and slice state and the frozen delivery order, then tell the user to start a new session at <workspace-root> and invoke the coding skill with the absolute frozen plan directory to implement the frozen plan.
  - A declined approval or a refused or incomplete distribution creates no tasks, slices, distribution or implementation prompt: report the exact result, keep the written artifacts repairable, state that the task set is not frozen, and give no implementation prompt.
  - An ordinary plan or a root-only workspace plan whose `workspace_repos` declares only the reserved workspace root entry may be implemented unsplit: tell the user to start a new session and invoke the coding skill to implement it.
  - Provide a concise copyable prompt in a text fence, written in the user's language and naming the actual absolute project or workspace root and frozen plan directory with no illustrative placeholders; for a child-participating workspace plan, for example:
    ```text
    Start a new session at <workspace-root> and invoke the coding skill with the absolute frozen plan directory <absolute plan directory> to implement the frozen plan.
    ```
- Apart from the chained task artifacts and slices that the `plan-to-tasks` preparation procedure writes for a child-participating workspace plan, the planning session created no task, slice, worktree, implementation record, workflow, run, code file or commit.
