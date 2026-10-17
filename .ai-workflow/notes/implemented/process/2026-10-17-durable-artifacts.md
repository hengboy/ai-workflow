# Agent Note: Durable self-contained artifacts

Status: implemented

English | [中文](2026-10-17-durable-artifacts.zh.md)

## Problem

Durable artifacts that outlive their plan still anchored to transient plan-internal identifiers. Note bodies, Git commit messages and code comments copied task IDs, step numbers, phase numbers, `REQ`/`AC` IDs and plan directory names from the plan that produced them, but the plan directory is gitignored and deleted after delivery, so a later reader saw dangling anchors instead of the delivered result, decision or behavior. Existing active notes already carried such anchors, no rule governed cleaning them, the `git-message` contract let a task ID travel with the summary, and no review axis checked the same class in delivered notes and comments.

## Decision

- The project contract, the notes README, the `git-message` contract and its reference, the Git Operator, the coding skill, the Standards Review, `README.md` and `MEMORY.md` carry one rule: durable artifacts stay self-contained after their plan is gone and describe the delivered result, decision or behavior in durable project terms.
- Note bodies, commit messages and code comments never carry transient plan-internal identifiers such as task IDs, step numbers, phase numbers, `REQ`/`AC` IDs or plan directory names; code comments explicitly include class- and type-level documentation comments.
- The notes README governs note content and adds the cleanup rule: an existing active note that still carries such an identifier is cleaned by rewriting the anchor into a durable description while preserving its decision, alternatives, consequences and evidence claims, with both language sides updated together and the pair re-recorded, when the note is next maintained or in an authorized bounded cleanup pass.
- The `git-message` contract requires a standalone message whose subject states the delivered result and whose subject, body and footer stay free of the identifiers, and Git Operator rejects a violating message with evidence instead of passing it to `git commit`.
- The Standards Review reports such an identifier in a delivered note or comment as an error finding with a concrete correction rather than style taste.
- The workspace cross-repository plain plan-ID note reference is the only sanctioned exception; sealed archived notes, commit history and existing code comments outside the change's write scope stay byte-unchanged, and no validator scans shipped prose for the rule.

## Alternatives considered

- **A prospective-only rule without cleanup.** Declined: it leaves identifiers in existing notes dangling after their gitignored plan is deleted, and the user required existing note content to adopt the new way rather than only future artifacts.
- **Banning only task and step numbers.** Declined: `REQ`/`AC` IDs, phase numbers and plan directory names dangle equally once the plan is gone, so a partial identifier set would leave the same defect.
- **Mechanical validator enforcement.** Declined: a prose scan cannot distinguish governance text that documents this rule from a violation, and semantic review owns whether note content is truthful and durable.
- **Rewriting commit history or sealed archived notes.** Declined: they are immutable history, and rewriting either would fabricate a different past instead of delivering the rule.
- **Removing the workspace cross-repository plan-ID reference.** Declined: it is the sanctioned cross-repository anchor, and its removal would be a separate contract change.

## Consequences

- This repository's own six active note pairs that still carried transient identifiers are cleaned in this change: only the anchors were rewritten durably, every decision, alternative, consequence and evidence claim was preserved, both language sides changed together and the pairs were re-recorded.
- Adopted projects clean their own historical active notes by running the emitted migration prompt under the updated README, which names the identifier set, requires preserving each record and re-recording the pair, forbids rewrites of archived notes, commit history and existing code comments, and reports when no active note needs cleaning.
- The rule ships through the existing generated project contract and notes README snapshot and the existing skill installation, so no CLI, schema, triplet or lifecycle change is part of delivery.
- The change retires the permissive wording that let a commit message carry a task ID, and the shipped-content tests guard the contract, the README, the `git-message` surfaces, the coding skill, the Standards Review and the active-note scan.
- This record does not supersede a related active note: it complements [the note rationale and retention record](./2026-10-16-note-rationale-and-retention.md), which owns when a note is required and which retention outcome applies.
