# Agent Note: Review evidence and shared skills

Status: implemented

English | [中文](2026-11-05-review-evidence-and-shared-skills.zh.md)

## Problem

A fresh reviewer given only the original delivery base and repaired head could not distinguish an existing omission from a repair regression. Generic task-packet examples also conflicted with Spec Review's restricted inputs. The single repair allowance stopped on either kind of new defect, while speculative boundary concerns added work without proving supported reachability. Local host copies and backup skill trees could make the primary load older dispatch instructions than its reviewers.

## Decision

- The coding review reference supplies separate initial and recheck packets for each axis. Initial review completes assigned coverage despite blockers and retains complete findings over the report-length target. Spec receives frozen requirements and raw evidence; Standards receives applicable standards, factual findings and versioned check evidence.
- Rechecks keep the original delivery base and add the immediately preceding reviewed head, a separate repair diff and required immutable blobs. Reviewers identify whether a gap existed before repair, was introduced by repair or has unknown provenance; the primary maps closure and distinguishes omissions from unresolved findings. A targeted PASS covers its stated scope and head only.
- Each boundary has at most two repair/recheck cycles. A second cycle requires a concrete in-scope correction with new defect evidence or demonstrated closure progress. No progress, unavailable evidence, scope change or exhausted budget blocks acceptance; completing missing raw evidence at an unchanged head consumes no repair cycle. New sessions never reset the budget.
- Logic defects require supported reachability and expected behavior grounded in a public contract, documented use, invariant or required standard. Rare reachable defects remain errors. Security uses the actual trust boundary; speculative or unreachable concerns do not become actionable findings. Existing advisory treatment of behavior-preserving redundancy and durable comments remains.
- Skills have one physical source under `~/.agents/skills`. Codex and OpenCode discover it directly; Claude Code uses its supported personal-directory link to that tree. Host-native agents stay separate. The installer compares resolved paths so a shared alias is not a shadow skill, creates no host skill copies or backup trees, and never performs destructive local cleanup without authorization.

## Alternatives considered

- **Give Spec the implementer's fix narrative.** Rejected because raw before/after code supplies causal evidence without prescribing closure or contaminating the independent requirement judgment.
- **Ban newly discovered defects or allow unlimited full reviews.** Rejected because neither establishes correct delivery; bounded targeted continuation retains real defects and explicit stopping reasons.
- **Maintain synchronized per-host skill copies.** Rejected because independently stale copies caused contradictory dispatch inputs. A shared physical tree removes that version divergence while retaining Claude's supported loading entry.

## Consequences

- `tests/behavior/review-dispatch.test.ts` checks the four public prompt examples, evidence/provenance obligations and bounded continuation; `tests/install/sync-hooks.test.ts` exercises real filesystem links and reinstalls. These are static instruction and installer behavior checks, not a claim that live reviewers always comply or find every defect.
- [Review boundaries and repair](2026-10-14-review-boundaries-and-repair.md) retains its routing, status/verdict separation, integration guarantees and historical smoke evidence; this record partially supersedes its repair-budget and recheck-input decisions. [Standards code review](2026-11-02-standards-code-review.md) retains its axis ownership and dimensions; this record refines its reachability and finding thresholds. Both remain active and cross-linked because their independent rationale and coverage limits still apply.
