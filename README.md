# ai-workflow

A self-contained macOS/Node.js 22 CLI for installing planning/context skills and native role agents for Codex, Claude Code and OpenCode. Planning produces frozen `spec.md`, `plan.md` and `tasks/*.md` documents, each a complete bilingual triplet; agents choose an appropriate level of planning and verification for each change.

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
ai-workflow plan pairing --plan .ai-workflow/plans/<planId>
ai-workflow plan pairing --plan .ai-workflow/plans/<planId> --list
ai-workflow plan pairing --plan .ai-workflow/plans/<planId> --write spec plan
ai-workflow plan pairing --plan .ai-workflow/plans/<planId> --write --all
ai-workflow context validate [--project .] --all
ai-workflow context validate [--project .] --feature <id>
ai-workflow context locate [--project .] --feature <id> --verify
ai-workflow context candidate --project . --output <candidate.json> --task-target <id> --root <module-root> --path <changed-file>
ai-workflow context refresh --project . --candidate <candidate.json> --write
ai-workflow context discover --project . --packet <fallback.json>
ai-workflow notes validate [--project .]
ai-workflow notes list [--project .] [--archived]
ai-workflow notes pairing [--project .] [<note>...]
ai-workflow notes pairing --project . --list
ai-workflow notes pairing --project . --write <note> | --write --all
ai-workflow notes archive [--project .] --seal
```

`--project` is always a project root directory path. From that directory use `--project .` (project root directory path); from elsewhere pass an absolute path such as `--project /path/to/project`. Internal orchestration uses absolute project-root paths, and a relative `--candidate` is resolved from that project root.

Navigation is JSON-authoritative. `context locate` resolves a feature by exact ID then exact alias; task queries match exact feature, alias, task, requirement, or acceptance-criterion IDs; symbols match an exact export name or qualified `file#symbol` name. A hit returns exact indexed paths; `missing_index`, `miss`, `stale`, and `invalid` return a fallback packet that must be validated before bounded discovery. `context candidate` emits the structured input for refresh, while `context refresh` atomically replaces `navigation.json` and its generated Markdown view only after candidate validation succeeds.

`ai-workflow notes` works on the Agent Notes under `.ai-workflow/notes/`, which are the project's proposal and decision records, maintained as complete bilingual English/Chinese triplets. The retired ADR mechanism has no command, alias, migration path or fallback: existing local ADR history files are left untouched but are never read, listed or validated by the workflow.

Every planning artifact under `.ai-workflow/plans/<planId>/` is a complete bilingual triplet, the same contract as Agent Notes: planning writes `spec.md` and `plan.md` as `<doc>.md` (English) plus `<doc>.zh.md` (Chinese) and `<doc>.i18n.yaml` (consistency record), and plan-to-tasks writes each `tasks/task-NNN-slug.md` the same way. The English side alone carries the YAML frontmatter, the `REQ-###`/`AC-###` identifiers and counts and the `digest`; the Chinese side has no frontmatter and starts with the same English title, then `[English](<doc>.md) | 中文`, while the English side carries `English | [中文](<doc>.zh.md)`. Both sides mirror each other's heading, code, table, list and link structure. Task enumeration treats only `task-NNN-slug.md` as a main document and reports a `.zh.md` or `.i18n.yaml` without a matching main document as an orphan error, and the `.i18n.yaml` record is never treated as a third body.

Frozen `spec.md` and `plan.md` files use a shared digest protocol: each file hashes its exact UTF-8 bytes with only its own frontmatter `digest` line replaced by `digest: ""`; the workflow input digest combines the two resulting digests as stable JSON. Digest semantics are unchanged: only the English bytes participate, and a Chinese-side edit never changes the `digest`. Use `ai-workflow plan validate --plan <directory>` after planning and before task splitting or coding. Beyond the existing `plan_id`, `status`, count and digest checks, it now enforces the triplet — the `.zh.md` and `.i18n.yaml` siblings, the exact language switchers, the mirrored structure and recorded hashes equal to the current bytes — and still returns the unchanged success shape `{ "valid": true, "plan_id": ..., "digests": ... }`.

`ai-workflow plan pairing --plan <directory>` verifies and records the pair hashes, mirroring `ai-workflow notes pairing`:

- `ai-workflow plan pairing --plan <directory>` with no flags is a read-only check. It writes nothing, reports `{ "valid": true, "errors": [] }` on success and exits nonzero when a spec, plan or task document is missing a sidecar, diverges structurally or has a stale or absent record.
- `ai-workflow plan pairing --plan <directory> --list` reports `missing`, `out-of-sync` or `ok` per document and always exits 0.
- `ai-workflow plan pairing --plan <directory> --write <document>` records the current English and Chinese blob hashes, where a document may be given as `<doc>.md`, `<doc>.zh.md`, `<doc>.i18n.yaml` or a bare `spec`, `plan` or `task-NNN-slug` slug. Every explicitly selected document is pre-checked first, and an incomplete selection writes no record at all. `--write --all` records only complete pairs and skips incomplete ones without failing.

A recorded pair is an explicit, reviewable state rather than a silent refresh: the default and `--list` modes never write, and `--write` requires either explicit documents or `--all`. Existing single-language plans under `.ai-workflow/plans/` are not migrated, converted or exempted; they fail the new validation by design and their bytes are left untouched.

## Project initialization and navigation

`ai-workflow init /path/to/project` writes `MEMORY.md`, `.ai-workflow/AGENTS.md`, the `.ai-workflow/notes/` management tree, the generated `.ai-workflow/index/navigation.json` and `.ai-workflow/index/navigation.md`, and the required entries in `.gitignore`. Only `.ai-workflow/plans/` is gitignored; `MEMORY.md` and the rest of `.ai-workflow/` travel with Git and arrive in worktrees through Git. It does not write, preflight or conflict on root-level `AGENTS.md`/`CLAUDE.md`. It discovers repository files, optionally reads user configuration, and builds and validates navigation. An ordinary filesystem failure removes only files/directories created by that invocation and restores the original `.gitignore` bytes.

`ai-workflow init <project> --upgrade` completes the management structure of an existing project. It requires an existing `.ai-workflow/` directory, `MEMORY.md` and both navigation files, and reports anything missing without writing. It creates only missing management files and `notes/` lifecycle and category directories, and reports existing matching files and directories as `skipped`, so the returned `created` and `skipped` lists are separate. It preserves existing `MEMORY.md`, navigation, plans, `project.yml`, notes and local ADR history byte for byte. A management file that differs from the template, and a `MEMORY.md` or project contract that still instructs agents to create or read ADRs, are reported with the exact path (and line for rule conflicts) before any write; merge those explicitly and retry. Repeating an upgrade reports an empty `created`.

### Agent Notes

`.ai-workflow/notes/` is the only current proposal and decision-record mechanism. `init` creates the governance files (`.ai-workflow/notes/AGENTS.md`, `.ai-workflow/notes/README.md`, the `implemented/` and `archived/` instructions and an empty `archived/manifest.json`) together with the `proposed`, `implemented`, `rejected` and `archived` lifecycle directories for the `architecture`, `bug-fix`, `feature`, `process`, `simplification` and `testing` classes. No placeholder records are generated.

`.ai-workflow/notes/README.md` is the single source for note format, lifecycle, supersession and archive governance, and `.ai-workflow/AGENTS.md` points to it. Every note is a three-file sibling pair named `{lifecycle}/{class}/YYYY-MM-DD-topic-title.md`, `.zh.md` and `.i18n.yaml`: the English body, the Chinese body and a consistency record holding each side's git blob hash. Both languages carry equal authority and must mirror each other's structure; the fixed `# Agent Note:` prefix, section headings, field names, status values, paths and dates remain English while the prose is translated. `ai-workflow notes list --project <root>` derives the current English records on every read, `ai-workflow notes validate --project <root>` checks the tree, triplet completeness, language switchers, mirrored structure, recorded hashes, active links and archive integrity, `ai-workflow notes pairing --project <root>` verifies or (`--write`) re-records pairs, and `ai-workflow notes archive --project <root> --seal` verifies every existing manifest entry and every new triplet before it appends.

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

### Implementation record

Coding writes the single permitted run record at `<project>/.ai-workflow/plans/<planId>/implementation.yaml`. Before the first implementation step it holds `plan_id` with `status: in-progress` and an ISO 8601 `started_at` and no `completed_at`; after the final merge and the cleanup of only the run-owned worktree and branch it becomes `status: completed` with an ISO 8601 `completed_at` and the final commit SHA, preserving `plan_id` and `started_at`. The record has only the two status values `in-progress` and `completed`; an interrupted run stays at `in-progress` with only the start fields and no failure reason. Only a frozen plan creates this record, and coding creates no other workflow manifest or run record. `ai-workflow plan validate` and `ai-workflow plan pairing` neither require nor read this file.

## Profiles

Store profiles at `~/.config/ai-workflow/profiles/<name>.yaml`, then activate one with `ai-workflow profile activate <name>` or the installed `$switch-profile` skill. `~/.config/ai-workflow/config.yaml` is the single configuration source, and it stores the top-level optional `active_profile` field. Activation only accepts an existing, valid profile, writes or updates `active_profile` in `config.yaml`, and immediately reinstalls agents for every host already managed by ai-workflow. It always targets the explicit `<name>` argument; it never reads the current `active_profile` value as its activation target. Its JSON report lists each host, agents directory, installed agent path and explicit profile model settings. Later `install` or upgrade commands resolve the active profile from `active_profile` in `config.yaml` and reuse it automatically.

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

## Optional real-host smoke

After logging into each local CLI, initialize a disposable Git repository, create a frozen plan, install into a temporary HOME, generate/approve a workflow and invoke one no-write node with the corresponding host. Never run this smoke against a working project or real HOME. Automated tests use fake host CLIs and temporary repositories.
