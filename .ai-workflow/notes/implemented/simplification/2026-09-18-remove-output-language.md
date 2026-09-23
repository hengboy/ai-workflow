# Agent Note: Remove the output_language configuration

Status: implemented

English | [中文](2026-09-18-remove-output-language.zh.md)

## Problem

The optional `output_language` key in `~/.config/ai-workflow/config.yaml` once localized generated prose, but the artifact families that depended on it had become complete bilingual triplets: Agent Notes and planning artifacts are always written in English and Chinese together, and only their structural elements stay English. The preference therefore no longer selected anything still generated in one language, yet it kept a configuration surface that could drift from the always-bilingual contract and forced a reinstall whenever the user changed it.

## Decision

- The `output_language` configuration feature was removed entirely. `~/.config/ai-workflow/config.yaml` now carries only the optional top-level `active_profile` field, alongside the allowed `version` key. The key was deleted from `schemas/settings.schema.json`, `src/settings/index.ts` (the `OutputLanguage` type and `loadOutputLanguage` are gone) and the generated settings types.
- The schema keeps `additionalProperties: false`, so a leftover `output_language` key is now an unknown key that fails configuration loading before install writes any managed file; users must delete it.
- Install no longer injects any prose-language directive: `src/install/render.ts` lost its output-language section, so installed skills and role agents are written byte-for-byte from their templates and only the per-host frontmatter conversion remains. This also removed the install-time coupling that made changing the preference require reinstalling.
- Agent Notes and planning artifacts remain always-complete bilingual triplets, and no configuration selects their languages.
- The planning skill's numbered workflow in `templates/skills/planning/SKILL.md` now drafts and writes all six frozen files (`spec.md`/`spec.zh.md`/`spec.i18n.yaml` and `plan.md`/`plan.zh.md`/`plan.i18n.yaml`) and treats `ai-workflow plan validate --plan <directory>` as a hard completion gate, so `spec.md` or `plan.md` is never frozen without its `.zh.md` and `.i18n.yaml`.
- The `standards-review` role and README/MEMORY were updated to drop the preference language.
- This record partially supersedes the `output_language` claims in [localize ADR prose at install time](../process/2026-09-14-localize-adr-prose-at-install-time.md), [bilingual note triplets](../process/2026-09-17-bilingual-note-triplets.md) and [bilingual planning artifacts](../process/2026-09-17-bilingual-planning-artifacts.md); those records keep their decisions and rationale, and their current language facts point here.

## Alternatives considered

- **Keep the key but make it inert.** Declined: it would leave a dead configuration surface that users keep setting, documents keep explaining and validation keeps accepting even though nothing reads it.
- **Ignore unknown keys silently.** Declined: it would weaken configuration validation and hide typos, including a mistyped `active_profile`, by loading settings that the schema never approved.
- **Keep a fixed built-in English directive.** Declined: it would still imply a changeable preference and reintroduce the install-time coupling where the directive must be injected and refreshed by reinstalling.

## Consequences

- A leftover `output_language` key now fails configuration loading until the user removes it; there is no compatibility shim and no silent fallback.
- Installed skills and role agents are the template bytes plus the per-host frontmatter conversion only, so the template becomes the single source and install is no longer coupled to a prose preference.
- Bilingual triplets stay enforced mechanically: `ai-workflow plan validate` and `ai-workflow notes validate` remain the gates, not a configuration value.
- The prose language is no longer configurable; agents follow the host and session context, and the always-bilingual artifact rule is the only language guarantee.
