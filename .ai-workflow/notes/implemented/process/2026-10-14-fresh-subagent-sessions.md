# Agent Note: Fresh sub-agent sessions for completed roles

Status: implemented

English | [中文](2026-10-14-fresh-subagent-sessions.zh.md)

## Problem

A delegated role session that returned execution Status `done` stayed eligible as the target of the next delegation. The shipped contract and `coding` guidance required batching a role's work into one dispatch per step and allowed a second dispatch only for a review repair with new evidence, but they never ended a completed sub-agent session or required a new native session for later same-role work. Nothing prohibited passing a completed session identifier to a continuation field, and nothing bounded the context a fresh session receives. Completed-task conversation context could therefore keep accumulating across later implementation, repair, verification or recheck, documentation and Git delegations and degrade effectiveness, while a new session lacked an explicit statement of the current required context.

## Decision

- A sub-agent session that returns execution Status `done` is finished. Every later task, repair, verification or recheck, documentation and Git delegation to the same named role starts a new native sub-agent session; the completed session is never reused or resumed, including by passing its identifier to a continuation field or any other continuation mechanism.
- The rule is one boundary across those later delegations; it grants no new authority and never treats a `done` result as review PASS. Reusing the role name with a new session stays valid.
- The new session explicitly reads or completely receives the current required project context, `MEMORY.md`, both navigation files, the project contract, the current task goal, exact read/write scopes, permitted commands and relevant accepted results or actionable findings instead of the entire previous conversation.
- The rationale is that completed-task context can accumulate and degrade effectiveness; a fresh session limits that accumulation, and no measured performance gain is claimed.
- The rule is stated in `templates/project/AGENTS.md` (`## Orchestration`), its tracked `.ai-workflow/AGENTS.md` mirror and the `coding` skill's `## Delegation and Scheduling`; `README.md` and `MEMORY.md` carry the same standard, and `navigation.json` records the `fresh-subagent-sessions` feature with its generated Markdown.

## Alternatives considered

- **Continue the completed session for later same-role work.** Declined: the completed session keeps accumulating completed-task context that can degrade effectiveness, and the requested behavior is a new session per later delegation.
- **Start a new session but copy the whole previous conversation into it.** Declined: a new session that copies the entire prior conversation preserves the accumulation the change is meant to bound; only the current context and relevant accepted results or actionable findings transfer.

## Consequences

- Later same-role implementation, repair, verification or recheck, documentation and Git work now starts a fresh native session with a bounded current packet, while execution Status stays separate from a review Verdict and the existing authorization and review boundaries are unchanged.
- The tracked `.ai-workflow/AGENTS.md` mirror is kept equal to `templates/project/AGENTS.md` in this change, and installed Coding is written byte-identically to `templates/skills/coding/SKILL.md` because install copies the template verbatim; other roles and skills receive the rule through the shared project contract, so no role template or other skill changed.
- The focused shipped-content case in `tests/behavior/coding-v2-content.test.ts` was observed RED before the prompt change: `pnpm exec vitest run tests/behavior/coding-v2-content.test.ts` failed the case at its `contract ## Orchestration ends the session once Status done is returned` assertion while the 17 existing cases passed, because the rule was absent.
- The scoped shipped-content, install-propagation and documentation checks are the static acceptance boundary; a passing run would establish delivered prompt guidance and would still not prove host runtime enforcement, review acceptance or a measured model improvement.
- [Review boundaries and repair](./2026-10-14-review-boundaries-and-repair.md) keeps its independent review and repair decision, and [Automatic implementation commit](./2026-10-14-automatic-implementation-commit.md) keeps its automatic local-commit decision; this record does not supersede either and preserves the existing primary-session recovery and unfinished or blocked handling.
- A native session identifier, when a host reports one after a later same-role delegation, is supplementary host evidence and creates no extra workflow artifact, fixture or transcript.
