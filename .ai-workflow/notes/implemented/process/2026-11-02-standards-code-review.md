# Agent Note: Standards code review

Status: implemented

English | [中文](2026-11-02-standards-code-review.zh.md)

## Problem

The shipped Standards Review checked MEMORY and note compliance but did not judge the delivered code itself. A planned implementation could pass both review axes while carrying a logic hole, an unhandled boundary, an unexplained security exposure or newly introduced redundancy, because Spec Review is requirement-only and no axis owned delivered-code quality. Adding that judgment needed a home that preserved the existing review routing, triggers, axes, role count and read-only boundary instead of creating a parallel review path.

## Decision

- Delivered-code quality review belongs to the existing second (Standards) axis: Standards Review keeps its MEMORY and notes consistency mandate and adds the code judgment, so review routing, the change-class triggers, the two axes and the role count stay unchanged and no new role or third axis exists.
- The axis judges three dimensions inside the supplied immutable range: logic and boundary correctness; security risk with a written risk explanation; and redundancy plus key-comment quality.
- Severity maps to defect capability: a logic or boundary finding is an error when incorrect behavior, an unhandled boundary, state corruption or a resource leak is possible, and otherwise an advisory warning; a security finding is an error only for a plausible exploitable, privilege-escalating or data-exposing risk, a speculative or unreachable concern is an advisory warning with its reasoning, and a finding without a risk explanation is incomplete and is not accepted as a blocker; a redundancy or key-comment finding stays advisory unless it causes a defect.
- A redundancy finding is limited to code introduced by the reviewed change and proposes the smallest behavior-preserving simplification; a key-comment finding names non-obvious logic and the durable behavior or rationale to document, never a transient plan-internal identifier.
- The review stays bounded and read-only: it reads only packet-authorized paths, the supplied diff, bounded source context at the same immutable range, MEMORY and supplied evidence, and it never searches, runs Git or tests, edits files, invents requirements or reports uncited style taste.
- The policy ships in the Standards Review role template, the project contract and its byte-identical tracked mirror, the coding skill, README and MEMORY, and is guarded by `tests/behavior/review-policy.test.ts`.

## Alternatives considered

- **Add a third review role or axis for code quality.** Declined: the existing Standards axis already owns delivered judgment against project standards, and a new axis would change review routing, batch composition and role count without adding an independent decision.
- **Make every redundancy or key-comment finding a blocker.** Declined: most such findings do not change behavior, so blocking on them would turn advisory cleanup into merge risk; they stay advisory unless they cause a defect.
- **Move delivered-code review into the requirement-only Spec Review.** Declined: Spec Review judges frozen requirements and acceptance at the immutable range and must stay independent of implementation quality, so code judgment there would blur the axis separation and the separate payloads.

## Consequences

- The three dimensions and severity semantics are now stated consistently in `templates/agents/standards-review.md`, `templates/project/AGENTS.md` with its byte-identical mirror `.ai-workflow/AGENTS.md`, `templates/skills/coding/SKILL.md`, `README.md` and `MEMORY.md`, and guarded by `tests/behavior/review-policy.test.ts`.
- Validation evidence is static shipped-content evidence, not live model behavior: the mirror comparison exited 0, and the targeted batch of `tests/behavior/review-policy.test.ts`, `tests/behavior/notes-content.test.ts`, `tests/behavior/coding-v2-content.test.ts` and `tests/integration/global-agent-guidance.test.ts` exited 0 with 105 tests. The product commit is `5c0bda37bfa261d61b65da269a65e4754226e540`.
- Routing is unchanged: Direct and Mechanical changes dispatch neither axis, Planning dispatches only the Spec Review, plan-to-tasks dispatches neither, and an ordinary planned implementation keeps one simultaneous full Spec and Standards batch; installed hosts receive the updated checklist on the next install or upgrade.
- [Review boundaries and repair](./2026-10-14-review-boundaries-and-repair.md) keeps its routing, aggregate-repair, recheck and integration rationale; this record adds the delivered code-quality judgment and does not supersede that record.
