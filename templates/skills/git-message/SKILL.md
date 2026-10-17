---
name: git-message
description: Generate a precise Conventional Commit message from an authorized change scope and verified diff, without performing Git mutations.
---

# Git Message

## Scope and evidence

Generate one commit message for the authorized, verified changes. Text only: do not alter files, choose or expand the commit's path scope, approve a commit, or run any Git mutation (`git add`, `git commit`, `git merge`, etc.). Required inputs:

- The user-approved outcome or frozen plan/task objective.
- The exact repository-relative paths authorized for the commit.
- The relevant diff or an evidence-backed summary of the actual changes.
- The validation evidence available for those changes.

If exact paths cannot separate the change from unrelated work, return `blocked` and identify the ambiguity. Do not invent missing changes or infer a broader scope. Base claims only on supplied evidence; exclude unrelated, unverified or merely planned work and unreported validations.

## Message contract

Use Conventional Commits 1.0.0:

`<type>(<optional scope>): <Chinese summary>`

- Choose the narrowest accurate type from `feat`, `fix`, `docs`, `test`, `refactor`, `build`, `ci`, or `chore`; add a scope only when it materially clarifies the affected product area.
- Write a concise Chinese summary of the delivered result, not the work process, with no ending punctuation or claim outside the authorized diff. The message stands alone for a reader who never sees the plan: the subject states the delivered result in durable product terms, and neither the subject, body nor footer carries a transient plan-internal identifier such as a task ID, step number, phase number, `REQ`/`AC` ID or plan directory name.
- Breaking changes require both `!` and a `BREAKING CHANGE:` footer. Add a Chinese body only when it materially clarifies motivation, compatibility, or validation; keep the subject sufficient on its own.

Read [the commit message template](references/commit-message.md) when a body or breaking-change footer is needed. Replace its illustrative example with claims supported by the authorized diff and reported validation.

## Selection and output

1. Compare the requested outcome with the actual changed paths and diff.
2. Apply the message contract and return only the proposed message plus a concise mapping from its claims to changed paths for the Git Operator to verify before committing.
