# ai-workflow

A self-contained macOS/Node.js 22 CLI for installing planning/context skills and native role agents for Codex, Claude Code and OpenCode. Planning produces frozen `spec.md`, `plan.md` and task documents; agents choose an appropriate level of planning and verification for each change.

The product does not execute, depend on or provide compatibility for external workflow frameworks or provider APIs.

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
ai-workflow update [/path/to/project]
ai-workflow plan validate --plan .ai-workflow/plans/<planId>
ai-workflow context validate [--project .] --all
ai-workflow context validate [--project .] --feature <id>
ai-workflow context locate [--project .] --feature <id> --verify
ai-workflow context candidate --project . --output <candidate.json> --task-target <id> --root <module-root> --path <changed-file>
ai-workflow context refresh --project . --candidate <candidate.json> --write
ai-workflow context discover --project . --packet <fallback.json>
```

`--project` is always a project root directory path. From that directory use `--project .` (project root directory path); from elsewhere pass an absolute path such as `--project /path/to/project`. Internal orchestration uses absolute project-root paths, and a relative `--candidate` is resolved from that project root.

Navigation is JSON-authoritative. `context locate` resolves a feature by exact ID then exact alias; task queries match exact feature, alias, task, requirement, or acceptance-criterion IDs; symbols match an exact export name or qualified `file#symbol` name. A hit returns exact indexed paths; `missing_index`, `miss`, `stale`, and `invalid` return a fallback packet that must be validated before bounded discovery. `context candidate` emits the structured input for refresh, while `context refresh` atomically replaces `navigation.json` and its generated Markdown view only after candidate validation succeeds.

Frozen `spec.md` and `plan.md` files use a shared digest protocol: each file hashes its exact UTF-8 bytes with only its own frontmatter `digest` line replaced by `digest: ""`; the workflow input digest combines the two resulting digests as stable JSON. Use `ai-workflow plan validate --plan <directory>` after planning and before task splitting or coding.

## Project initialization and navigation

`ai-workflow init /path/to/project` preflights the managed targets (`AGENTS.md`, `CLAUDE.md`, `MEMORY.md`, `.ai-workflow/index/navigation.json`, `.ai-workflow/index/navigation.md`) and fails before writing when any already exists. It then discovers repository files, optionally reads user configuration, builds and validates navigation, and publishes the documents plus `.ai-workflow/project-manifest.json`. The manifest records the actual written bytes; an ordinary filesystem failure removes only files/directories created by that invocation, restores the original `.gitignore` bytes and leaves no partial manifest.

### Repository discovery

Discovery performs a deterministic, bounded scan of the project. It excludes `.git`, `.ai-workflow`, `node_modules`, `vendor`, `target`, `build`, `dist`, `coverage`, `.next` and `.cache`, does not traverse symlinks that leave the project, and supports empty projects. Paths are project-relative, slash-separated and ordered by locale-independent comparison; the scan reports no silent truncation. Even though `.ai-workflow` is excluded from traversal, `.ai-workflow/project.yml` is read explicitly.

### Optional project configuration

An optional, user-owned `.ai-workflow/project.yml` (version 1) declares modules and features. The tool never generates, overwrites or records this file in the ownership manifest, and an existing configuration is not an init conflict.

```yaml
version: 1
modules:
  - id: backend
    path: backend
    languages: [java]
    source_roots: [src/main/java]
    test_roots: [src/test/java]
features:
  - id: users
    name: Users
    module_root: backend
    paths: [backend/src/main/java/example/users, backend/src/test/java/example/users]
```

- A module `path` is project-relative and is the declared ownership boundary; `source_roots` and `test_roots` are relative to the module and `languages` lists one or more languages. Each module maps to exactly one navigation root; a module with several languages is recorded as `mixed`.
- Feature `paths` are project-relative, must stay within the feature's `module_root`, and expand to concrete indexed files. Both `modules` and `features` lists may be empty, and explicit features take priority while discovery supplements uncovered content. Uncovered files in a declared module keep that module.
- Invalid configuration fails before any write: malformed YAML, schema violations, duplicate module/feature IDs, features referencing unknown modules, nonexistent paths, paths outside the project, overlapping module boundaries and duplicate feature file ownership are all reported with the offending field/path.

### Language capabilities

- TypeScript and JavaScript use the TypeScript compiler for semantic extraction and carry the `exported-symbol` capability. JavaScript reuses that compiler capability rather than a separate ad hoc parser.
- Java is structural only. Conventional Maven/Gradle layouts (`pom.xml`, `build.gradle`, `build.gradle.kts`), packages and Spring classes (`@SpringBootApplication`, `@RestController`, `@Controller`, `@Service`, `@Repository`, `@Configuration`) are recognized without a Java AST. Java roots carry the `file` capability and never claim symbols or relations; a file that cannot be classified reliably is retained as a structural candidate with an internal `java-unclassified` diagnostic.
- Unknown or unsupported languages use a structural file fallback. Mixed modules dispatch analysis per file language so Java files are never interpreted as TypeScript.

### Navigation lifecycle

Navigation is JSON-authoritative version-1 output produced by a single builder, and `.ai-workflow/index/navigation.md` is rendered exclusively from that JSON. Validation dispatches by capability: structural roots are checked for file existence and coverage, while semantic roots are checked for exported symbols and import relations. `context validate`, `context locate --feature <id> --verify` and the authorized `context refresh` (which reuses the same adapters and preserves structural coverage) all operate on the generated navigation. A language that claims the semantic `exported-symbol` capability without a supported parser is rejected.

### Update

`ai-workflow update` unconditionally skips `.ai-workflow/index/navigation.json` and `.ai-workflow/index/navigation.md`: it never replaces generated navigation with empty templates and never recreates missing navigation. Other managed templates keep their existing ownership rules, and a missing project manifest still errors. Navigation maintenance uses `context refresh`.

## Profiles

Store profiles at `~/.config/ai-workflow/profiles/<name>.yaml`, then activate one with `ai-workflow profile activate <name>` or the installed `$switch-profile` skill. `~/.config/ai-workflow/config.yaml` is the single configuration source, and it stores the top-level optional `active_profile` field alongside `output_language`. Activation only accepts an existing, valid profile, writes or updates `active_profile` in `config.yaml`, and immediately reinstalls agents for every host already managed by ai-workflow. It always targets the explicit `<name>` argument; it never reads the current `active_profile` value or a legacy marker as its activation target. Its JSON report lists each host, agents directory, installed agent path and explicit profile model settings. Later `install` or upgrade commands resolve the active profile from `active_profile` in `config.yaml` and reuse it automatically.

Do not hand-edit the `active_profile` field in `config.yaml`; use `ai-workflow profile activate <name>` so the value is validated and agents are reinstalled.

### Legacy active-profile marker migration

Older ai-workflow versions stored the active profile in a standalone `~/.config/ai-workflow/active-profile` marker file. That marker is deprecated; `config.yaml` is the only runtime source, and an `install` without an explicit profile migrates the marker at most once:

- When `config.yaml` has no `active_profile` and the `active-profile` marker holds a non-empty value, ai-workflow validates that value as a profile and, after a successful install, writes it to `active_profile` and deletes the marker.
- When `config.yaml` already has an `active_profile`, that value wins; the marker cannot overwrite it and is deleted after a successful install.
- When the marker value cannot be loaded as a valid profile, the command fails before writing any managed file, leaves `config.yaml` unchanged and keeps the marker.
- `ai-workflow profile activate <name>` never activates the marker value, but deletes the marker after a successful explicit activation, even when the marker value is invalid.

`uninstall` never creates, modifies or deletes `config.yaml`.

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

## Output language

Natural-language prose in generated planning artifacts (`spec.md`, `plan.md` and `tasks/*.md`) is localized through `~/.config/ai-workflow/config.yaml`, the single user-owned configuration source that also carries the optional `active_profile` field described under Profiles.

```yaml
output_language: zh-CN
```

- `output_language` accepts `en` (English) or `zh-CN` (Simplified Chinese). The default is `en` when the file or the field is absent.
- The language is resolved when `ai-workflow install` runs, so changing it requires re-running `ai-workflow install` or the installed `$switch-profile` skill, which reinstalls through the same path.
- Only the installed `planning` and `plan-to-tasks` skills receive the directive, and only natural-language prose is translated: headings, table headers, YAML frontmatter keys and their order, `REQ-###`/`AC-###` identifiers, file paths, code and enumerated values such as `surface` remain English.
- An unsupported value or malformed configuration fails installation before any managed file is written. The file remains user-owned: ai-workflow reads `output_language` and writes only `active_profile`, preserving existing keys, and never records the file in the install manifest.

## Optional real-host smoke

After logging into each local CLI, initialize a disposable Git repository, create a frozen plan, install into a temporary HOME, generate/approve a workflow and invoke one no-write node with the corresponding host. Never run this smoke against a working project or real HOME. Automated tests use fake host CLIs and temporary repositories.
