# Agent Note: Move the agent contract into user-level global instruction files

Status: implemented

English | [中文](2026-09-14-user-level-agent-contract.zh.md)

## Problem

`ai-workflow init` used to write project-level `AGENTS.md` and `CLAUDE.md` and abort the preflight when either already existed; `ai-workflow update` maintained those managed templates together with a dedicated `.ai-workflow/project-manifest.json`. This duplicated the same agent contract in every project: the contract could not take effect once per user, any project that already had a hand-written `AGENTS.md`/`CLAUDE.md` was rejected by `init`, and the maintenance command was bound to the project file ownership record.

## Decision

Move the agent contract to the user level: `ai-workflow install` writes or refreshes a marker block delimited by `<!-- ai-workflow:begin -->` and `<!-- ai-workflow:end -->` in each host's global instruction file — opencode `~/.config/opencode/AGENTS.md`, claude `~/.claude/CLAUDE.md`, codex `~/.codex/AGENTS.md`. The contract text is single-sourced from `templates/contract/AGENTS.md` and shared by all three hosts; each host records `path`, the block-level `digest` and `created` in the top-level `contracts` map of `~/.config/ai-workflow/install-manifest.json`.

`ai-workflow init` writes only `MEMORY.md`, `.ai-workflow/**` and `.gitignore`, and no longer writes or preflights project-level `AGENTS.md`/`CLAUDE.md`. The project-level `AGENTS.md`/`CLAUDE.md` contract templates, the `ai-workflow update` subcommand and `.ai-workflow/project-manifest.json` are removed together; existing project-level `AGENTS.md`/`CLAUDE.md` are left untouched.

That mechanism has been superseded: the 2026-09-16 [project contract and Agent Notes replacement record](../process/2026-09-16-project-contract-and-agent-notes.md) kept the "contract takes effect once per user installation" direction, but the full contract text in the global file was narrowed to a short loading entry and the full contract moved into the adopting project's `.ai-workflow/AGENTS.md` (single-sourced from `templates/project/AGENTS.md`). `install` still maintains the user-level marker block and the `contracts` record; what was superseded is the level at which the contract text lives, not the marker-block mechanism.

## Alternatives considered

- **Keep the project-level contract and let `update` maintain it.** Declined: the contract text is duplicated in every project, projects with a hand-written `AGENTS.md`/`CLAUDE.md` are still rejected by preflight, and the benefit of taking effect once per user cannot be realized.
- **Keep writing `.ai-workflow/project-manifest.json` to preserve the ownership record.** Declined: the only managed objects left are user-level global files, so the project-level manifest has no consumer.
- **Customize the contract text per host.** Declined: the rules are identical across the three hosts, so one single-source template avoids divergence and drift.

## Consequences

- The contract takes effect for every project once per user installation, and applies only when the project root contains `.ai-workflow/`; hand-written project-level `AGENTS.md`/`CLAUDE.md` no longer conflict with `init` and are neither written nor modified.
- Content outside the block is preserved byte for byte; re-running `install` refreshes an unmodified block, skips a hand-edited block and reports `skipped`, adopts a valid unowned block, and treats malformed or duplicate markers as a conflict without modifying the file. `uninstall --host <host>` removes only the marker block.
- The block is recorded in the top-level `contracts` map rather than in a `hosts` entry, so older uninstall logic cannot delete the whole global file; after an older `install` drops `contracts`, the on-disk block becomes unowned and is adopted by the new version.
- Removing the `update` subcommand and `.ai-workflow/project-manifest.json` is a breaking change; the version was `0.1.0` at the time.
- `README.md`, `templates/skills/setup-ai-workflow/SKILL.md` and `MEMORY.md` were aligned to the new semantics in the same change.
- Cost of the supersession: the contract text no longer exists in full in the global file, and a project missing `.ai-workflow/AGENTS.md` must use `ai-workflow init <project-root> --upgrade` as its repair entry instead of falling back to the old full global contract.
