---
name: git-message
description: Generate a precise Conventional Commit message from an authorized change scope and verified diff, without performing Git mutations.
---

# Git Message

## Outcome

Return one commit message that accurately describes the authorized, verified changes. This skill generates text only. It must not run any Git mutation, stage files, create a commit, or expand the caller's authorized scope.

## Required inputs

- The user-approved outcome or frozen plan/task objective.
- The exact repository-relative paths authorized for the commit.
- The relevant diff or an evidence-backed summary of the actual changes.
- The validation evidence available for those changes.

If the change cannot be separated from unrelated work by exact path, return `blocked` and identify the ambiguity. Do not invent missing changes or infer a broader scope.

## Message contract

Use Conventional Commits 1.0.0:

`<type>(<optional scope>): <Chinese summary>`

Choose the most accurate type from `feat`, `fix`, `docs`, `test`, `refactor`, `build`, `ci`, or `chore`. Add a scope only when it makes the affected product area materially clearer.

The Chinese summary must describe the delivered result, not the work process. Keep it concise, do not end it with punctuation, and do not claim behavior outside the authorized diff.

Use `!` and a `BREAKING CHANGE:` footer for a breaking change. Add a Chinese body only when it materially clarifies motivation, compatibility, or validation; keep the subject sufficient on its own.

Read [the commit message template](references/commit-message.md) when a body or breaking-change footer is needed. Replace its illustrative example with claims supported by the authorized diff and reported validation.

## Selection procedure

1. Compare the requested outcome with the actual changed paths and diff.
2. Exclude unrelated, unverified, or merely planned work from the message.
3. Select the narrowest accurate type and optional scope.
4. Draft the Chinese result summary and add a body/footer only when required by the message contract.
5. Return only the proposed message and a concise mapping from message claims to changed paths so the Git Operator can verify it before committing.

## Prohibited actions

- Do not run `git add`, `git commit`, `git merge`, or any other Git mutation.
- Do not approve a commit, alter files, or choose its path scope.
- Do not include task IDs as a substitute for a meaningful result summary.
- Do not mention validations that were not actually reported.

## Completion checklist

- The message follows Conventional Commits 1.0.0.
- Its type, scope and Chinese summary match the authorized diff.
- Breaking-change syntax is present when required.
- The response contains no Git side effect and no claim beyond supplied evidence.
