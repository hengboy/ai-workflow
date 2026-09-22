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

Before repository context work, directly read `.ai-workflow/AGENTS.md`, `MEMORY.md`, `.ai-workflow/index/navigation.json` and `.ai-workflow/index/navigation.md`. The project contract applies to the whole project and to every participating agent. Treat absent `MEMORY.md` as a recorded legal state. For a known feature run `ai-workflow context locate --project <absolute-project-root> --feature <id> --verify`, then read only its exact `read_order`. `<absolute-project-root>` is the normalized project directory path, never its directory name. Do not search the repository. If locate returns `missing_index`, `miss`, `stale` or `invalid`, request File Explorer with the original goal, status/reason and authorized module roots. Keep each task `read_scope` to the fixed context (`.ai-workflow/AGENTS.md`, `MEMORY.md`, both navigation files) plus exact locator paths; it must not contain `src/`, `tests/` or the project root. Add relevant notes and governance files only as exact bounded paths.

## Clarification loop

Ask the highest-priority clarifying question per turn. Pick the unanswered item whose ambiguity would change the most downstream work:

- goal and measurable outcome;
- explicit non-goals;
- actors and primary/alternate scenarios;
- functional requirements;
- acceptance criteria and observable evidence;
- compatibility, performance, privacy and platform constraints;
- invalid inputs, failures, cancellation and recovery;
- validation layers and what must fail before implementation (RED).

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

Before requesting confirmation, verify that:

- every requirement has one stable, continuous `REQ-###` identifier;
- every acceptance criterion has one stable, continuous `AC-###` identifier;
- each REQ maps to at least one AC and every AC names observable behavior;
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

Show the complete goals, non-goals, REQ/AC inventory, scenarios, constraints, error boundaries and verification matrix in one preview. Ask for explicit approval. Until approval:

- do not create the plan directory;
- do not write or overwrite `spec.md` or `plan.md`;
- do not freeze a digest;
- do not create task or workflow files.

Material user changes invalidate the preview and require a new complete preview.

## Draft and review workflow

After approval:

1. Draft both documents in memory, every side of each: the English `spec.md` and `plan.md`, their Chinese `spec.zh.md` and `plan.zh.md` prose sides, and the `spec.i18n.yaml` and `plan.i18n.yaml` consistency records. You must not write drafts, snapshots or any other planning artifacts to a system temporary directory (or any temporary path outside the plan directory). If SHA-256 calculation requires filesystem input, write `spec.md` and `plan.md` directly under `.ai-workflow/plans/<planId>/`, re-read them there for the digest, and then make any required content or frontmatter updates in that same plan directory before freezing; never use a temporary directory as an intermediate location.
2. Ask Spec Review exactly once to check coverage, testability, contradictions, read/write bounds, sequencing, rollback and role assignment.
3. Treat any error finding as a failed gate. Revise the draft, show the full changed inventory and obtain renewed user approval; after that repair, continue to the next step without invoking Spec Review again.
4. Only after the single review has passed (or its findings have been repaired and accepted) write all six frozen files atomically in `.ai-workflow/plans/<planId>/`: the frontmattered English `spec.md` and `plan.md`, the no-frontmatter Chinese `spec.zh.md` and `plan.zh.md`, and the `spec.i18n.yaml` and `plan.i18n.yaml` consistency records. A missing Chinese side or consistency record is an incomplete triplet, not a smaller deliverable: never freeze `spec.md` or `plan.md` without its `.zh.md` and `.i18n.yaml`. When provisional files were materialized for SHA-256 calculation, update or replace those same files in the plan directory and do not copy them through a temporary directory.
5. Re-read all six files and verify their shared plan ID, counts, frozen status and content digests.
6. Record the pair with `ai-workflow plan pairing --plan <directory> --write spec plan`, then verify the complete frozen triplet with `ai-workflow plan validate --plan <directory>`. `plan validate` is a hard completion gate, not an optional check: when it reports a missing `.zh.md` or `.i18n.yaml`, a wrong switcher, a structure mismatch or a stale digest, repair the offending side, re-record and run the gate again until it passes. Do not report completion, and do not hand off to Plan-to-tasks or Coding, while any triplet is incomplete.

The planning primary agent owns document writes. Spec Review is read-only.

Planning artifacts live under `.ai-workflow/plans/<planId>/`, which is gitignored. Planning creates no Git commit: do not dispatch Git Operator and do not stage or commit `spec.md`, `plan.md` or any other planning artifact. Leave them as local, untracked files.

## Document contract

Write to `.ai-workflow/plans/<YYYYMMDD-english-slug>/`:

- `spec.md` + `spec.zh.md` + `spec.i18n.yaml`: goal, non-goals, scenarios, continuous REQ/AC, Given/When/Then evidence, RED criteria, boundary counterexamples and validation layers.
- `plan.md` + `plan.zh.md` + `plan.i18n.yaml`: every REQ/AC mapping, implementation order, exact or bounded read/write paths, checks, compatibility, rollback and responsible native role.

Each of these is a complete bilingual triplet: the English main document and its `.zh.md` Chinese prose side, plus an `.i18n.yaml` consistency record for the pair. Only the English side carries the YAML frontmatter (`plan_id`, `status: frozen`, `created_at`, `supersedes`, counts and `digest`). The `.zh.md` side has no frontmatter; it starts with the same English title followed by `[English](<doc>.md) | 中文`, while the English side follows its title with `English | [中文](<doc>.zh.md)`. Both sides differ only in prose; mirror headings, structure, tables, lists and link targets, and never treat `.i18n.yaml` as a third prose side.

Plan steps use `Responsible role`; `plan.md` itself does not require a
`surface` attribute. Surface routing is added only to generated task files.

Before drafting, read [the specification template](references/spec.md) and [the implementation plan template](references/plan.md). Preserve their contracts while replacing the illustrative example content with the approved requirements and repository-specific evidence.

## Agent Notes

Planning schedules note work; the change that lands a decision owns its record and lifecycle transition. Read `.ai-workflow/notes/AGENTS.md` for the entry points and `.ai-workflow/notes/README.md`; that README is the single source for note format, lifecycle, supersession and archive governance. Do not restate those governance rules here.

`MEMORY.md` records the current standards (how) while notes record why; keep them consistent in the same change.

When a change affects architecture, module boundaries or ownership, public protocols or schemas, cross-cutting standards, workflow or agent rules, behavior, testing strategy, configuration or a persistent format, the `plan.md` must contain an explicit step that adds or updates the relevant note, and the plan must align `MEMORY.md` with that note in the same change. Major unimplemented work is scheduled as `proposed`; a change that lands a decision moves its note to `implemented` and rewrites the body to delivered facts. Purely mechanical or local edits that change none of the above may be exempt.

## Frozen-plan digest protocol

Use the normative convention in [the digest protocol](references/digest.md). Write both English frontmatters with `digest: ""`, calculate each file's SHA-256 over its exact UTF-8 bytes with only that digest line blanked, and replace the values; the English bytes are the only digest source and the Chinese side never affects the digest. After both language sides are final and the digests are written, record the pair with `ai-workflow plan pairing --plan <directory> --write spec plan`, then verify the complete frozen triplet with `ai-workflow plan validate --plan <directory>` before finishing. `plan validate` and `plan pairing` are the shared verification entry points for frozen planning artifacts. Do not invent or calculate a digest from the completed self-referential file.

Both frontmatters contain `plan_id`, `status: frozen`, `created_at`, nullable `supersedes`, REQ count, AC count and a content digest. A changed frozen requirement creates a new plan ID; never edit a frozen plan in place.

## Completion checklist

- The user approved the final full inventory.
- Every non-mechanical plan schedules its note maintenance and aligns `MEMORY.md`; purely mechanical changes are exempt.
- Spec Review ran exactly once; it either passed or all of its findings were repaired and included in the user's final approval.
- `spec` and `plan` are frozen bilingual triplets: `spec.md`/`spec.zh.md`/`spec.i18n.yaml` and `plan.md`/`plan.zh.md`/`plan.i18n.yaml` all exist.
- Both English documents share the same plan ID and counts, and both `.zh.md` sides mirror their English structure.
- The pair is recorded in `spec.i18n.yaml` and `plan.i18n.yaml`, and `ai-workflow plan validate --plan <directory>` passes.
- Digests match the frozen English bytes.
- No Git commit was created for `spec.md` or `plan.md`; both remain gitignored local artifacts under `.ai-workflow/plans/<planId>/`.
- No task, workflow, run or code file was created.
