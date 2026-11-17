# Agent Note: Planning and review decision quality

Status: implemented

English | [中文](2026-11-17-planning-decision-quality.zh.md)

## Problem

Planning could ask the right business-impact questions and still freeze a plan built on an unexamined premise: the stated request stood in for the underlying outcome, the impact of the change stayed implicit, and the leading approach arrived without its strongest objection or a considered alternative. A direct defect fix could also close the reported symptom while leaving its cause and no stable regression test, and Standards Review could judge logic, security, redundancy and comments while saying nothing about whether the delivered code stayed maintainable. Those gaps let a clean-looking delivery carry the wrong problem, a repeated defect or a context load that a new maintainer had to reconstruct.

## Decision

- Planning begins with problem framing: it records the stated request, the underlying outcome and whether that request is the outcome, a means or a symptom before the clarification loop, and raises at most one bounded, non-blocking challenge that continues the original request when it is declined or not adopted.
- A plan records the direct and second-order impact with evidence at a depth proportional to the change, and the leading approach with its strongest objection, the evidence that answers it or the alternative that survives, every materially different alternative considered and an explicit no-material-alternative statement that never invents one.
- A direct defect fix reproduces the defect with a stable public-interface regression test, states the triggering condition and cause, fixes the cause rather than the symptom and retains that regression test, without a new review gate.
- Standards Review adds a maintainability lens to its existing delivered-code judgment: confusing naming, an abstraction that hides the data flow, unclear ownership and a context load that forces a new maintainer to reconstruct non-obvious intent. Each finding names the exact path or symbol and the concrete context cost and stays advisory unless it causes a defect, and a naming or formatting preference without that cost is not a finding.
- The rules live in `templates/skills/planning/SKILL.md`, `templates/skills/planning/references/spec.md`, `templates/skills/planning/references/plan.md`, `templates/agents/spec-review.md`, `templates/skills/coding/SKILL.md`, `templates/agents/standards-review.md`, `templates/project/AGENTS.md` with its byte-identical mirror `.ai-workflow/AGENTS.md`, `MEMORY.md`, `README.md` and this record; no role, review axis, gate, runtime artifact or mandatory process step is added.

## Alternatives considered

- **Add a set of general-purpose reasoning prompts as new steps or gates.** Declined: it would reverse the recent prompt slimming, duplicate the existing clarification, review and note mechanisms, and add approval cost without changing a decision.
- **Add a separate adversarial or retrospective review capability.** Declined: it duplicates the existing Spec Review and needs a separate bounded Git-history surface, while the per-change planning and review gaps are higher leverage.
- **Change nothing in the shipped prompts.** Declined: the wrong-problem, symptom-fix and uncited-maintainability gaps were real, and only a delivered contract leaves reviewable evidence.

## Consequences

- A planned change carries a few more evidence-bearing lines and at most one bounded challenge; the depth stays proportional, so a bounded plan may state its impact in one line and its no-material-alternative case explicitly.
- A direct defect fix costs one stated cause and a retained regression test, and Standards Review can raise maintainability advisories that never block on style taste alone; routing, review triggers, the repair budget and the review packets stay unchanged.
- This record extends the maintainability dimension owned by [Standards code review](./2026-11-02-standards-code-review.md), the direct path owned by [Change routing](./2026-09-22-change-routing.md), the plan decision content alongside [Plan write-scope completeness](./2026-11-16-plan-write-scope-completeness.md) and the routing, repair and integration owned by [Review boundaries and repair](./2026-10-14-review-boundaries-and-repair.md); none of them is superseded, so each independently useful record stays active.
- Validation is static shipped-content evidence rather than live model behavior: the decision-quality behavior tests, the byte-identical contract mirror comparison and the notes and context validation gates all pass.
