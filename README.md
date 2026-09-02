# ai-workflow

A self-contained macOS/Node.js 22 CLI that installs planning, task-splitting and coding skills once into `~/.agents/skills`, plus the same native role agents for Codex, Claude Code and OpenCode. Planning uses the shared skills and host-native agents. Coding runs through a local, versioned JSON DAG with explicit approval, checkpoints, role/scope enforcement and Git worktrees.

The product does not execute, depend on or provide compatibility for external workflow frameworks. It calls exactly one selected host CLI per run and never calls model-provider APIs directly.

## Development

```sh
corepack enable
pnpm install
pnpm check
pnpm exec tsx src/cli.ts --help
```

Node 22 is the supported baseline. Newer Node versions may be used for development but do not replace Node 22 smoke verification.

## CLI overview

```sh
ai-workflow install --host codex|claude|opencode|all
ai-workflow uninstall --host codex|claude|opencode|all
ai-workflow profile activate <name>
ai-workflow init /path/to/project
ai-workflow update /path/to/project
ai-workflow workflow generate --plan .ai-workflow/plans/<planId> --host codex
ai-workflow workflow validate .ai-workflow/plans/<planId>/workflow.json
ai-workflow workflow explain .ai-workflow/plans/<planId>/workflow.json
ai-workflow workflow approve .ai-workflow/plans/<planId>/workflow.json
ai-workflow plan validate --plan .ai-workflow/plans/<planId>
ai-workflow run start --workflow .ai-workflow/plans/<planId>/workflow.json --host codex --project .
ai-workflow run status|resume|cancel|cleanup <runId> --project .
ai-workflow context validate --project . --all
ai-workflow context validate --project . --feature <id>
ai-workflow context locate --project . --feature <id> --verify
ai-workflow context candidate --project . --output <candidate.json> --task-target <id> --root <module-root> --path <changed-file>
ai-workflow context refresh --project . --candidate <candidate.json> --write
ai-workflow context discover --project . --packet <fallback.json>
```

`workflow generate` always writes the canonical `.ai-workflow/plans/<plan-id>/workflow.json` inside the project. It has no `--output` option and never creates a `workflow.candidate.json`.

`--project` is always a project root directory path. From that directory use `--project .` (project root directory path); from elsewhere pass an absolute path such as `--project /path/to/project`. Internal orchestration uses absolute project-root paths, and a relative `--candidate` is resolved from that project root.

Navigation is JSON-authoritative. `context locate` resolves a feature by exact ID then exact alias; task queries match exact feature, alias, task, requirement, or acceptance-criterion IDs; symbols match an exact export name or qualified `file#symbol` name. A hit returns exact indexed paths; `missing_index`, `miss`, `stale`, and `invalid` return a fallback packet that must be validated before bounded discovery. `context candidate` emits the structured input for refresh, while `context refresh` atomically replaces `navigation.json` and its generated Markdown view only after candidate validation succeeds.

`workflow generate --adjustments-stdin` reads a structured adjustment document from stdin. Natural-language feedback is converted to that schema by the installed coding skill; the CLI deliberately refuses unbounded natural-language mutation.

Frozen `spec.md` and `plan.md` files use a shared digest protocol: each file hashes its exact UTF-8 bytes with only its own frontmatter `digest` line replaced by `digest: ""`; the workflow input digest combines the two resulting digests as stable JSON. Use `ai-workflow plan validate --plan <directory>` after planning and before task splitting or coding.

## Profiles

Store profiles at `~/.config/ai-workflow/profiles/<name>.yaml`, then activate one with `ai-workflow profile activate <name>` or the installed `$switch-profile` skill. Activation only accepts an existing, valid profile, records it as the single active profile and immediately reinstalls agents for every host already managed by ai-workflow. Its JSON report lists each host, agents directory, installed agent path and explicit profile model settings. Later `install` or upgrade commands automatically reuse that active profile.

Each agent can choose a different model and reasoning effort for each host. Missing host entries inherit that host's normal defaults.

```yaml
version: 1.0.0
agents:
  backend:
    codex:
      model: gpt-5.6
      reasoning_effort: high
    claude:
      model: opus
      reasoning_effort: max
    opencode:
      model: openai/gpt-5.6-terra
      reasoning_effort: medium
  file-explorer:
    codex:
      model: gpt-5.6-luna
      reasoning_effort: low
```

Supported reasoning values are `low`, `medium`, `high`, `xhigh`, `max` and `ultra`. The installer converts the shared `reasoning_effort` field to each host's native agent configuration.

## Optional real-host smoke

After logging into each local CLI, initialize a disposable Git repository, create a frozen plan, install into a temporary HOME, generate/approve a workflow and invoke one no-write node with the corresponding host. Never run this smoke against a working project or real HOME. Automated tests use fake host CLIs and temporary repositories.
