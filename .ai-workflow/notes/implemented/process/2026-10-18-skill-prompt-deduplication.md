# Agent Note: Skill and sub-agent prompt deduplication with a mandatory tone

Status: implemented

English | [中文](2026-10-18-skill-prompt-deduplication.zh.md)

## Problem

The shipped skill and sub-agent prompt templates had accumulated repeated restatements of the same workflow rules and soft hedge wording, so readers met the same rule several times and some requirements read as optional. A single rule was restated inside the change-routing, preconditions, verification, workspace and synchronization sections of one file, and across the packet-handling and output-checklist boilerplate of every sub-agent template. Several normative statements were phrased with hedges such as `should`, `consider`, `try to`, `when it improves` and `if possible`, so the same requirement could be read as optional. The repetition consumed prompt budget without adding normative content, and the soft wording made common rules ambiguous.

## Decision

- **Duplicate-cluster registry and equivalence rule.** Within each in-scope prompt file, every registered duplicate cluster keeps exactly one authoritative statement carrying its original normative content. Deletions and merges remove only repetition, restatement and boilerplate; they never remove distinct normative content. Every sentence asserted by the shipped-content suites stays present verbatim, and no file under `tests/` was modified.
- **Mandatory tone policy.** Normative statements use `must`, `required`, `never` or `only`. The soft hedges `should`, `consider`, `try to`, `when it improves` and `if possible` are absent from the in-scope prompt files, and `may` remains only in genuine permission or optional-field contexts.
- **Three strengthenings.** The coding skill's `## Preconditions` section states the mandatory Todo-list rule, replacing a conditional bullet and folding in the proportional-scope clause. The coding skill's `## Verification and Commit` section requires a Test dispatch when a command verdict is needed, replacing the permissive phrasing. The coding workspace reference states the active-rebuild gate as `must not ... except at` while keeping the `active rebuild` keyword.
- **Per-cluster deletion record.** Each cluster's bounded before/after line counts are the acceptance evidence:
  - coding skill `## Work-boundary synchronization`: 23 → 7 physical lines; the single `ai-workflow sync-hook --host <host> --phase --project <root>` invocation, the once-at-skill-start cadence, the stored-result reuse and the decision routing are retained, while the manual-sync and stdin-payload restatements are deleted.
  - coding skill change-routing tail: the settled-request restatement is removed.
  - coding skill `## Delegation and Scheduling`: the two fresh-session bullets merge into one with every clause retained.
  - coding skill `## Preconditions`: the conditional Todo bullet is replaced by the mandatory Todo-list rule.
  - coding skill `## Implementation Record`: the reference pointer is shortened to one clause.
  - coding skill workspace route sections (`## Parent workspace execution`, `## Workspace finalization`): redundant tail clauses are trimmed.
  - coding skill `## Verification and Commit`: the duplicated lead-in is deleted and the Test dispatch is made required.
  - coding workspace reference `templates/skills/coding/references/workspace.md`: the activation, review and recovery restatements collapse to one statement each, and the active-rebuild gate is strengthened.
  - planning skill `templates/skills/planning/SKILL.md` `## Work-boundary synchronization`: 5 → 4 content lines, and the agent-notes governance restatement is removed.
  - plan-to-tasks skill `templates/skills/plan-to-tasks/SKILL.md`: the freeze-after-distribution rule is reduced to one authoritative statement with intra-file references, the outcome and invocation-mode restatements are trimmed, and `## Work-boundary synchronization` is 5 → 4 content lines.
  - nine agent templates: the `## Packet handling` blocks are compressed from 10 to 4 content lines each (54 lines removed) while keeping the exact absolute packet paths, the explicit per-command workdir, the child-repository contract self-read and `no nested dispatch`; the `## Output checklist` blocks lose two redundant blank lines each (18 lines removed).
  - git-operator agent `templates/agents/git-operator.md`: the duplicated finalization bullet merges into the single authoritative pointer-commit statement (5 lines removed), keeping the batch `git cat-file -e <sha>^{commit}` existence check, the never-stage-a-partial-batch rule and the exact `git update-index --cacheinfo 160000,<sha>,<path>` pin command.
  - light-touch files (the git-message, setup-ai-workflow, sync-ai-workflow and switch-profile skills and references, and the planning and plan-to-tasks references): unchanged because no removable redundancy existed without touching an asserted sentence.
- **Measured net reduction.** The 23 in-scope files went from 2142 to 2032 lines (−110), exceeding the at-least-100 target. Per-file after counts: `templates/skills/coding/SKILL.md` 352→329, `templates/skills/coding/references/workspace.md` 256→252, `templates/skills/planning/SKILL.md` 153→150, `templates/skills/plan-to-tasks/SKILL.md` 142→139, `templates/agents/git-operator.md` 128→115, `templates/agents/test.md` 71→63, `templates/agents/spec-review.md` 70→62, `templates/agents/standards-review.md` 67→59, `templates/agents/researcher.md` 66→58, `templates/agents/frontend.md` 64→56, `templates/agents/backend.md` 63→55, `templates/agents/file-explorer.md` 63→55, `templates/agents/documentation-maintainer.md` 62→54; all other in-scope files are unchanged.
- **No structural change.** No cross-file reference chain and no primary inline or re-read requirement was introduced, and frontmatter, headings and tool declarations are unchanged.

## Alternatives considered

- **Rewrite the prompt templates wholesale.** Declined: a full rewrite changes rule wording and destroys the verbatim-sentence oracle the shipped-content suites rely on, so it risks dropping normative content with nothing vouching for the replacement.
- **Delete beyond the registered clusters.** Declined: an unregistered deletion would silently weaken or drop normative content that no cluster equivalence had vouched for.
- **Replace restatements with cross-file pointers.** Declined: a pointer forces the primary to read another file and violates the orchestrator context boundary, trading prompt length for a read the packet model does not provide.
- **Leave the files as they were.** Declined: the at-least-100-line net-reduction target and the mandatory tone would not be achieved.

## Consequences

- The prompt templates are 110 lines shorter with identical workflow logic, and the shipped-content and installation suites pass without any test-file edit.
- The duplicate-cluster registry plus equivalence rule is reusable for later wording optimizations: a new cluster reuses the same removal-only-repetition rule and the same verbatim-sentence oracle.
- `MEMORY.md` and the navigation index stay unchanged because no standard, path, symbol or ownership changed, and this note records the why.
- The mandatory tone policy leaves every normative statement in the in-scope files explicit, while `may` remains only for genuine permission or optional-field contexts.
- No related active note is superseded: [Orchestrator context boundaries in delegated coding](./2026-10-17-orchestrator-context-boundaries.md) keeps its evidence, transport and rebuild decisions, and this record only removes their repeated restatement in the shipped prompts without changing any of those decisions.
