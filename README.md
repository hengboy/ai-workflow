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
ai-workflow init /path/to/project --upgrade
ai-workflow plan validate --plan .ai-workflow/plans/<planId>
ai-workflow context validate [--project .] --all
ai-workflow context validate [--project .] --feature <id>
ai-workflow context locate [--project .] --feature <id> --verify
ai-workflow context candidate --project . --output <candidate.json> --task-target <id> --root <module-root> --path <changed-file>
ai-workflow context refresh --project . --candidate <candidate.json> --write
ai-workflow context discover --project . --packet <fallback.json>
ai-workflow notes validate [--project .]
ai-workflow notes list [--project .] [--archived]
ai-workflow notes archive [--project .] --seal
```

`--project` is always a project root directory path. From that directory use `--project .` (project root directory path); from elsewhere pass an absolute path such as `--project /path/to/project`. Internal orchestration uses absolute project-root paths, and a relative `--candidate` is resolved from that project root.

Navigation is JSON-authoritative. `context locate` resolves a feature by exact ID then exact alias; task queries match exact feature, alias, task, requirement, or acceptance-criterion IDs; symbols match an exact export name or qualified `file#symbol` name. A hit returns exact indexed paths; `missing_index`, `miss`, `stale`, and `invalid` return a fallback packet that must be validated before bounded discovery. `context candidate` emits the structured input for refresh, while `context refresh` atomically replaces `navigation.json` and its generated Markdown view only after candidate validation succeeds.

`ai-workflow notes` works on the Agent Notes under `.ai-workflow/notes/`, which are the project's proposal and decision records. The retired ADR mechanism has no command, alias, migration path or fallback: existing local ADR history files are left untouched but are never read, listed or validated by the workflow.

Frozen `spec.md` and `plan.md` files use a shared digest protocol: each file hashes its exact UTF-8 bytes with only its own frontmatter `digest` line replaced by `digest: ""`; the workflow input digest combines the two resulting digests as stable JSON. Use `ai-workflow plan validate --plan <directory>` after planning and before task splitting or coding.

## Project initialization and navigation

`ai-workflow init /path/to/project` writes only local gitignored artifacts: `MEMORY.md`, `.ai-workflow/AGENTS.md`, the `.ai-workflow/notes/` management tree, the generated `.ai-workflow/index/navigation.json` and `.ai-workflow/index/navigation.md`, and the required entries in `.gitignore`. It does not write, preflight or conflict on root-level `AGENTS.md`/`CLAUDE.md`. It discovers repository files, optionally reads user configuration, and builds and validates navigation. An ordinary filesystem failure removes only files/directories created by that invocation and restores the original `.gitignore` bytes.

`ai-workflow init <project> --upgrade` completes the management structure of an existing project. It requires an existing `.ai-workflow/` directory, `MEMORY.md` and both navigation files, and reports anything missing without writing. It creates only missing management files and `notes/` lifecycle and category directories, and reports existing matching files and directories as `skipped`, so the returned `created` and `skipped` lists are separate. It preserves existing `MEMORY.md`, navigation, plans, `project.yml`, notes and local ADR history byte for byte. A management file that differs from the template, and a `MEMORY.md` or project contract that still instructs agents to create or read ADRs, are reported with the exact path (and line for rule conflicts) before any write; merge those explicitly and retry. Repeating an upgrade reports an empty `created`.

### Agent Notes

`.ai-workflow/notes/` is the only current proposal and decision-record mechanism. `init` creates the governance files (`.ai-workflow/notes/AGENTS.md`, `.ai-workflow/notes/README.md`, the `implemented/` and `archived/` instructions and an empty `archived/manifest.json`) together with the `proposed`, `implemented`, `rejected` and `archived` lifecycle directories for the `architecture`, `bug-fix`, `feature`, `process`, `simplification` and `testing` classes. No placeholder records are generated.

`.ai-workflow/notes/README.md` is the single source for note format, lifecycle, supersession and archive governance, and `.ai-workflow/AGENTS.md` points to it. Each note is one Markdown file named `{lifecycle}/{class}/YYYY-MM-DD-topic-title.md` and uses one prose language; the `# Agent Note:` title, section headings, field names, status values, paths and dates remain English. `ai-workflow notes list --project <root>` derives the current records on every read, `ai-workflow notes validate --project <root>` checks the tree, formats, active links and archive integrity, and `ai-workflow notes archive --project <root> --seal` verifies every existing manifest entry and every new record before it appends.

### User-level agent contract

`ai-workflow install` writes the shared agent loading entry once per host as a marker block between `<!-- ai-workflow:begin -->` and `<!-- ai-workflow:end -->` in that host's global instruction file:

- opencode `~/.config/opencode/AGENTS.md`
- claude `~/.claude/CLAUDE.md`
- codex `~/.codex/AGENTS.md`

The block is single-sourced from `templates/contract/AGENTS.md` and contains only the loading rule: identify the project root, and when it contains `.ai-workflow/`, explicitly read `.ai-workflow/AGENTS.md` and follow its contract for the entire project and every participating agent. The complete project contract is single-sourced from `templates/project/AGENTS.md` and written to `.ai-workflow/AGENTS.md` by `init`. Hosts are not assumed to load hidden directories recursively or to follow Markdown links, so the explicit read is required. A missing project contract is reported and directs the user to `ai-workflow init <project-root> --upgrade` instead of falling back to a previous global contract. A project without `.ai-workflow/` does not load workflow rules.

A missing global file is created; an existing file is preserved byte-for-byte outside the block. Re-running `install` refreshes an unmodified block in place, reports `skipped` and leaves the file untouched when a block was hand-edited, adopts a valid unowned block, and refuses malformed or duplicate markers without modifying the file. `uninstall --host <host>` removes only the marker block and deletes the file only when it created it and no other substantial content remains.

### Repository discovery

Discovery performs a deterministic, bounded scan of the project. It excludes `.git`, `.ai-workflow`, `.worktrees`, `node_modules`, `vendor`, `target`, `build`, `dist`, `coverage`, `.next` and `.cache`, does not traverse symlinks that leave the project, and supports empty projects. Paths are project-relative, slash-separated and ordered by locale-independent comparison; the scan reports no silent truncation. Even though `.ai-workflow` is excluded from traversal, `.ai-workflow/project.yml` is read explicitly.

### Optional project configuration

An optional, user-owned `.ai-workflow/project.yml` (version 1) declares modules and features. The tool never generates or overwrites this file, and an existing configuration is not an init conflict.

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

## Profiles

Store profiles at `~/.config/ai-workflow/profiles/<name>.yaml`, then activate one with `ai-workflow profile activate <name>` or the installed `$switch-profile` skill. `~/.config/ai-workflow/config.yaml` is the single configuration source, and it stores the top-level optional `active_profile` field alongside `output_language`. Activation only accepts an existing, valid profile, writes or updates `active_profile` in `config.yaml`, and immediately reinstalls agents for every host already managed by ai-workflow. It always targets the explicit `<name>` argument; it never reads the current `active_profile` value as its activation target. Its JSON report lists each host, agents directory, installed agent path and explicit profile model settings. Later `install` or upgrade commands resolve the active profile from `active_profile` in `config.yaml` and reuse it automatically.

Do not hand-edit the `active_profile` field in `config.yaml`; use `ai-workflow profile activate <name>` so the value is validated and agents are reinstalled.

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

Natural-language prose in generated planning artifacts (`spec.md`, `plan.md` and `tasks/*.md`) and in the agent's own interactive/session output is localized through `~/.config/ai-workflow/config.yaml`, the single user-owned configuration source that also carries the optional `active_profile` field described under Profiles.

```yaml
output_language: zh-CN
```

- `output_language` accepts `en` (English) or `zh-CN` (Simplified Chinese). The default is `en` when the file or the field is absent.
- The language is resolved when `ai-workflow install` runs, so changing it requires re-running `ai-workflow install` or the installed `$switch-profile` skill, which reinstalls through the same path.
- The directive is injected into exactly the installed `planning`, `plan-to-tasks` and `coding` skills and the installed `documentation-maintainer` role. Both the agent's interactive/session natural-language prose (clarification questions, confirmation previews, progress narration and final summary) and the natural-language prose of generated planning artifacts follow the configured language.
- Agent Notes written by `documentation-maintainer` follow `output_language` in the same way: each note uses one prose language and has no parallel translated copies. Structural elements remain English, including the `# Agent Note:` title, section headings, field names, `Status` and its values, file paths and dates. Changing the preference requires re-running `ai-workflow install` or `$switch-profile`. This is a user preference and prose-language inconsistency is not merge-blocking.
- Only natural-language prose is translated: headings, table headers, YAML frontmatter keys and their order, `REQ-###`/`AC-###` identifiers, file paths, code and enumerated values such as `surface` remain English.
- An unsupported value or malformed configuration fails installation before any managed file is written. The file remains user-owned: ai-workflow reads `output_language` and writes only `active_profile`, preserving existing keys, and never records the file in the install manifest.

## Optional real-host smoke

After logging into each local CLI, initialize a disposable Git repository, create a frozen plan, install into a temporary HOME, generate/approve a workflow and invoke one no-write node with the corresponding host. Never run this smoke against a working project or real HOME. Automated tests use fake host CLIs and temporary repositories.
