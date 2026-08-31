---
name: switch-profile
description: Switch the active ai-workflow profile, reinstall managed agents with that profile, and report the resulting host installations.
---

# Switch Profile

## Outcome

Activate one existing profile and use the local, self-contained `ai-workflow` CLI to reinstall agents for every host already managed by ai-workflow. Return the CLI's installation report; do not invoke an external orchestrator or provider API.

## Workflow

1. Obtain the exact profile name from the request. Profile files live at `~/.config/ai-workflow/profiles/<name>.yaml`.
2. Run `ai-workflow profile activate <name>` once. Use `--home <path>` only when the user explicitly targets another home directory or the surrounding test uses an isolated home.
3. Treat a zero exit status and parseable JSON output as success. Do not edit the profile, active-profile marker, install manifest, skill files, or agent files directly.
4. Report `active_profile`, then each entry in `installations` with its `host`, `agents_directory`, and installed agents. Include explicit `model` and `reasoning_effort` values when present; otherwise say the agent uses the host default.
5. If `installations` is empty, explain that the profile is active but no previously managed host had agents to reinstall. The user can install a host separately with `ai-workflow install --host <host>`.

If activation fails, return the CLI error and do not claim that the profile switched or that agents were reinstalled. Do not retry with a different profile or install additional hosts without the user's direction.
