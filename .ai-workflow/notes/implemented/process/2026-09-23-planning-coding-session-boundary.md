# Agent Note: Planning and coding session boundary

Status: implemented

English | [中文](2026-09-23-planning-coding-session-boundary.zh.md)

## Problem

[Change routing](./2026-09-22-change-routing.md) gave a planned change a Planning-first path but did not say where a session that discovers the missing plan should stop. The `coding` skill's planned-change bullet and its automatic-continuation rule read as one run — classify, plan, implement — so a session that entered Planning mid-flight could move from the validated `spec.md` and `plan.md` straight into implementation without the user explicitly starting a coding run.

## Decision

- When a `coding` session classifies a request as a planned change and no frozen plan exists, the session runs Planning first and then stops after the frozen plan passes its validation gate.
- The handoff reports the frozen plan path and tells the user to start a new session and invoke the coding skill to implement it.
- The planning session creates no implementation state: no worktree, no `implementation.yaml`, no implementation or review dispatch and no commit.
- The `planning` skill's completion checklist carries the same handoff, so a directly invoked Planning run also ends at the frozen plan instead of starting implementation.
- `tests/behavior/change-routing.test.ts` guards the shipped `coding` and `planning` text plus the README sentence, so reconnecting Planning to an automatic implementation start fails the suite.

## Alternatives considered

- **Continue into implementation in the same session after Planning.** Declined: the boundary is the requested behavior; the frozen plan is a fresh input that deserves a new session rather than a silent continuation of the planning context.
- **Stop after Planning without a handoff instruction.** Declined: ending a turn without the next step leaves the user without the required action; the handoff names the frozen plan path and the coding skill.
- **Rely on the planning skill's existing ban on invoking a coding workflow.** Declined: that ban constrains Planning's own actions, not the coding skill's continuation schedule, so a coding session could still carry its dispatch plan across the boundary.

## Consequences

- A planned change found inside a coding session now produces a frozen, validated plan and stops there; implementation resumes only in the new session, where the frozen plan is the boundary.
- [Change routing](./2026-09-22-change-routing.md) still owns the direct, mechanical and planned classification; this record adds only the Planning-to-Coding handoff.
- [The project contract and Agent Notes record](./2026-09-16-project-contract-and-agent-notes.md) remains current; no active note is superseded.
