---
name: planning
description: Clarify a feature one question at a time, review it, then freeze spec.md and plan.md.
---

# Planning

## Outcome

Turn an idea into an explicitly confirmed, independently reviewable `spec.md` and `plan.md`. Use only the current host's native skill and native sub-agents. Do not invoke a coding workflow, an external orchestrator, or provider APIs.

## Required inputs

- Project root and current product context.
- The user's goal or problem statement.
- Existing constraints supplied by the user or exact paths returned by File Explorer.
- A proposed English slug; normalize it to `YYYYMMDD-english-slug` only after scope is stable.

If the project root or goal is missing, ask for that information before drafting.

## Clarification loop

Ask exactly one highest-priority question per turn. Pick the unanswered item whose ambiguity would change the most downstream work:

- goal and measurable outcome;
- explicit non-goals;
- actors and primary/alternate scenarios;
- functional requirements;
- acceptance criteria and observable evidence;
- compatibility, performance, privacy and platform constraints;
- invalid inputs, failures, cancellation and recovery;
- validation layers and what must fail before implementation (RED).

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

## Confirmation gate

Show the complete goals, non-goals, REQ/AC inventory, scenarios, constraints, error boundaries and verification matrix in one preview. Ask for explicit approval. Until approval:

- do not create the plan directory;
- do not write or overwrite `spec.md` or `plan.md`;
- do not freeze a digest;
- do not create task or workflow files.

Material user changes invalidate the preview and require a new complete preview.

## Draft and review workflow

After approval:

1. Draft both documents in memory.
2. Ask Spec Review exactly once to check coverage, testability, contradictions, read/write bounds, sequencing, rollback and role assignment.
3. Treat any error finding as a failed gate. Revise the draft, show the full changed inventory and obtain renewed user approval; after that repair, continue to the next step without invoking Spec Review again.
4. Only after the single review has passed (or its findings have been repaired and accepted) write the two frozen files atomically.

The planning primary agent owns document writes. Spec Review is read-only.

## Document contract

Write to `ai-workflow/plans/<YYYYMMDD-english-slug>/`:

- `spec.md`: goal, non-goals, scenarios, continuous REQ/AC, Given/When/Then evidence, RED criteria, boundary counterexamples and validation layers.
- `plan.md`: every REQ/AC mapping, implementation order, exact or bounded read/write paths, checks, compatibility, rollback and responsible native role.

Both frontmatters contain `plan_id`, `status: frozen`, `created_at`, nullable `supersedes`, REQ count, AC count and a content digest. A changed frozen requirement creates a new plan ID; never edit a frozen plan in place.

## Completion checklist

- The user approved the final full inventory.
- Spec Review ran exactly once; it either passed or all of its findings were repaired and included in the user's final approval.
- Both files share the same plan ID and counts.
- Digests match the frozen content.
- No task, workflow, run or code file was created.
