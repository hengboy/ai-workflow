# ai-workflow

A self-contained macOS/Node.js 22 CLI for installing planning/context skills and native role agents for Codex, Claude Code and OpenCode. Planning produces frozen `spec.md`, `plan.md` and `tasks/*.md` documents, each a complete bilingual triplet; small requirements, feature adjustments and defect fixes are implemented directly, while new or ambiguous features keep the frozen plan and the dual-axis review.

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
ai-workflow sync [project]
ai-workflow sync [project] --check
ai-workflow plan validate --plan .ai-workflow/plans/<planId>
ai-workflow plan pairing --plan .ai-workflow/plans/<planId>
ai-workflow plan pairing --plan .ai-workflow/plans/<planId> --list
ai-workflow plan pairing --plan .ai-workflow/plans/<planId> --write spec plan
ai-workflow plan pairing --plan .ai-workflow/plans/<planId> --write --all
ai-workflow context validate [--project .] --all
ai-workflow context validate [--project .] --feature <id>
ai-workflow context rebuild [--project .] [--write]
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
ai-workflow workspace distribute --plan <directory>
ai-workflow workspace status --plan <directory>
ai-workflow workspace checkpoint --plan <directory> --repo <name>
```

`--project` is always a project root directory path. From that directory use `--project .` (project root directory path); from elsewhere pass an absolute path such as `--project /path/to/project`. Internal orchestration uses absolute project-root paths, and a relative `--candidate` is resolved from that project root.

Navigation is JSON-authoritative. `context locate` resolves a feature by exact ID then exact alias; task queries match exact feature, alias, task, requirement, or acceptance-criterion IDs; symbols match an exact export name or qualified `file#symbol` name. A hit returns exact indexed paths; `missing_index`, `miss`, `stale`, and `invalid` return a fallback packet that must be validated before bounded discovery. `context candidate` emits the structured input for refresh, while `context refresh` atomically replaces `navigation.json` and its generated Markdown view only after candidate validation succeeds.

`ai-workflow notes` works on the Agent Notes under `.ai-workflow/notes/`, which are the project's proposal and decision records, maintained as complete bilingual English/Chinese triplets. The retired ADR mechanism has no command, alias, migration path or fallback: existing local ADR history files are left untouched but are never read, listed or validated by the workflow.

Every planning artifact under `.ai-workflow/plans/<planId>/` is a complete bilingual triplet, the same contract as Agent Notes: planning writes `spec.md` and `plan.md` as `<doc>.md` (English) plus `<doc>.zh.md` (Chinese) and `<doc>.i18n.yaml` (consistency record), and plan-to-tasks writes each `tasks/task-NNN-slug.md` the same way. The English side alone carries the YAML frontmatter, the `REQ-###`/`AC-###` identifiers and counts and the `digest`; the Chinese side has no frontmatter and starts with the same English title, then `[English](<doc>.md) | 中文`, while the English side carries `English | [中文](<doc>.zh.md)`. Both sides mirror each other's heading, code, table, list and link structure. Task enumeration treats only `task-NNN-slug.md` as a main document and reports a `.zh.md` or `.i18n.yaml` without a matching main document as an orphan error, and the `.i18n.yaml` record is never treated as a third body.

Plan-to-tasks freezes the task graph's execution order with the split. It computes each task's phase as one greater than the latest phase of its dependencies, so tasks at the same depth form one parallel group, previews the parallel phases and the critical path (the longest dependency chain) in the approval preview, and writes `tasks/execution-order.yaml`: the frozen `plan_id` plus an ordered list of non-empty parallel phases that covers every task exactly once, places every dependency in a strictly earlier phase and keeps same-phase write scopes disjoint. The schedule is machine-readable like `implementation.yaml` and has no `.zh.md` or `.i18n.yaml` sibling, and the written file matches the approved preview. A later coding session reads it as the only schedule for a split plan: it processes phases in file order, dispatches every task of a phase concurrently with test work before implementation inside each task, waits for and verifies the whole phase, and keeps Git commits serial — one task write scope per commit through Git Operator — before advancing, all inside the single worktree. A missing or invalid order stops the run before execution; coding never recomputes phases from `depends_on` and never falls back to serial execution.

Frozen `spec.md` and `plan.md` files use a shared digest protocol: each file hashes its exact UTF-8 bytes with only its own frontmatter `digest` line replaced by `digest: ""`; the workflow input digest combines the two resulting digests as stable JSON. Digest semantics are unchanged: only the English bytes participate, and a Chinese-side edit never changes the `digest`. Use `ai-workflow plan validate --plan <directory>` after planning and before task splitting or coding. Beyond the existing `plan_id`, `status`, count and digest checks, it now enforces the triplet — the `.zh.md` and `.i18n.yaml` siblings, the exact language switchers, the mirrored structure and recorded hashes equal to the current bytes — and, whenever the plan directory contains task documents, it also loads and validates `tasks/execution-order.yaml`, reporting the ordered phase ID arrays as `execution_order`: a missing file, a `plan_id` mismatch, malformed YAML or shape, an unknown, duplicated or omitted task ID, a dependency in the same or a later phase and overlapping write scopes inside one phase all fail. A plan directory with no task documents neither requires nor reads the schedule and keeps the unchanged success shape `{ "valid": true, "plan_id": ..., "digests": ... }`. Pre-existing task sets split before this change have no schedule and fail the new validation by design; they are neither migrated nor regenerated, and legacy single-language plans keep failing as before.

`ai-workflow plan pairing --plan <directory>` verifies and records the pair hashes, mirroring `ai-workflow notes pairing`:

- `ai-workflow plan pairing --plan <directory>` with no flags is a read-only check. It writes nothing, reports `{ "valid": true, "errors": [] }` on success and exits nonzero when a spec, plan or task document is missing a sidecar, diverges structurally or has a stale or absent record.
- `ai-workflow plan pairing --plan <directory> --list` reports `missing`, `out-of-sync` or `ok` per document and always exits 0.
- `ai-workflow plan pairing --plan <directory> --write <document>` records the current English and Chinese blob hashes, where a document may be given as `<doc>.md`, `<doc>.zh.md`, `<doc>.i18n.yaml` or a bare `spec`, `plan` or `task-NNN-slug` slug. Every explicitly selected document is pre-checked first, and an incomplete selection writes no record at all. `--write --all` records only complete pairs and skips incomplete ones without failing.

A recorded pair is an explicit, reviewable state rather than a silent refresh: the default and `--list` modes never write, and `--write` requires either explicit documents or `--all`. Existing single-language plans under `.ai-workflow/plans/` are not migrated, converted or exempted; they fail the new validation by design and their bytes are left untouched.

## Project initialization and navigation

`ai-workflow init /path/to/project` writes `MEMORY.md`, `.ai-workflow/AGENTS.md`, the `.ai-workflow/notes/` management tree, the generated `.ai-workflow/index/navigation.json` and `.ai-workflow/index/navigation.md`, and the required entries in `.gitignore`. Only `.ai-workflow/plans/` is gitignored; `MEMORY.md` and the rest of `.ai-workflow/` travel with Git and arrive in worktrees through Git. On init and `--upgrade`, a legacy whole-tree `.ai-workflow` or `.ai-workflow/` entry and a legacy `MEMORY.md` entry are removed in place, so only the `plans/` subtree stays ignored while every other `.gitignore` line is preserved. It does not write, preflight or conflict on root-level `AGENTS.md`/`CLAUDE.md`. It discovers repository files, optionally reads user configuration, and builds and validates navigation. An ordinary filesystem failure removes only files/directories created by that invocation and restores the original `.gitignore` bytes.

`ai-workflow init <project> --upgrade` completes the management structure of an existing project. It requires an existing `.ai-workflow/` directory, `MEMORY.md` and both navigation files, and reports anything missing without writing. It creates only missing management files and `notes/` lifecycle and category directories, and reports existing matching files and directories as `skipped`, so the returned `created` and `skipped` lists are separate. It preserves existing `MEMORY.md`, navigation, plans, `project.yml`, notes and local ADR history byte for byte. A management file that differs from the template, and a `MEMORY.md` or project contract that still instructs agents to create or read ADRs, are reported with the exact path (and line for rule conflicts) before any write; merge those explicitly and retry. Repeating an upgrade reports an empty `created`.

### Project template synchronization

Adopted projects keep their managed workflow instructions consistent with the fixed upstream source `hengboy/ai-workflow` branch `simplify`. `ai-workflow sync [project]` patches an existing adoption, and an omitted project defaults to the actual current directory normalized to its adopted root; `ai-workflow sync [project] --check` computes the same verdict and proposed patch without writing any target byte. Synchronization is incremental section patching, never a whole-file template copy, a CLI build or a historical template lookup. `ai-workflow init <project> --upgrade` shares the same patch core but uses the shipped local project templates with a null source commit; local upgrade makes no upstream freshness claim and reports `needs_attention` with an unverified local-source warning while retaining its missing-prerequisite conflict and its exact retired-ADR imperative guard. A fresh `init` still writes the marked template instructions and generated navigation, which synchronization never rewrites.

`src/sync/source.ts` acquires the current templates with a shallow temporary clone — `git clone --depth 1 --branch simplify https://github.com/hengboy/ai-workflow.git` into a throwaway directory — pins the single immutable 40-hex HEAD commit, reads and validates the nine supported `templates/project` files from that clone, and then removes the temporary directory before returning. Per-file validation checks identity, encoding, size, ownership-marker structure and the archive-manifest shape. Acquisition reads no token and no credential file and uses no GitHub CLI or SSH configuration, so it carries no API quota and no credential surface. Native events read the stored gate result without a further source request, and no previous-template baseline, project manifest, version stamp or synchronization run record is stored.

The report is JSON with `project`, `source` (`repository`, `branch` and a nullable `commit`), `status`, `verified`, `proceed`, `check`, `created`, `updated`, `skipped`, `warnings` and `conflicts`. Exit codes are 0 for `synchronized`, 2 for the warning statuses `unverified` and `needs_attention`, and 1 for `pending`, `conflict` and `failed`. The statuses are:

| Status | Exit | Verified | Proceed | Meaning |
| --- | --- | --- | --- | --- |
| `synchronized` | 0 | true | true | The complete source and management structure are current. |
| `unverified` | 2 | false | true | Source acquisition failed; existing content is retained. |
| `needs_attention` | 2 | false | true | Safe patches may land; ambiguous or retired content remains. |
| `pending` | 1 | false | false | Check-only result with safe changes still to apply. |
| `conflict` | 1 | false | false | Blocking ownership, prerequisite or structural conflict; no writes. |
| `failed` | 1 | false | false | Publication failed; the original state was restored or the exact recovery failure reported. |

A warning result — `unverified` or `needs_attention` — proceeds with visible context and makes no freshness claim; partial or unverified results are never treated as current. Source failure leaves every target byte unchanged and continues with an `unverified` warning. `--check` writes nothing and reports `pending`, and repeating a synchronization creates no duplicate section or wholesale copy and rewrites no identical file, reporting it as `skipped`. Every supported target is preflighted before any write: a structural conflict writes nothing, and an ordinary publication failure restores the invocation-local original bytes and removes only artifacts this invocation created, reporting a recovery failure truthfully when the filesystem keeps failing.

Ownership is defined by stable `<!-- ai-workflow:section <id>:begin -->` and `<!-- ai-workflow:section <id>:end -->` markers. A malformed, duplicate, nested or unclosed marker is a structural conflict; only bytes inside a valid owned section may be replaced, and every byte outside it, line endings included, is preserved. The supported targets and strategies are:

| Source artifact | Target artifact | Strategy |
| --- | --- | --- |
| `templates/project/AGENTS.md` | `.ai-workflow/AGENTS.md` | Patch owned contract sections; preserve and warn on unmarked differences. |
| `templates/project/MEMORY.md` | `MEMORY.md` | Patch only owned workflow sections; preserve independent project standards and architecture. |
| `templates/project/notes/AGENTS.md` | `.ai-workflow/notes/AGENTS.md` | Patch owned governance sections. |
| `templates/project/notes/README.md` | `.ai-workflow/notes/README.md` | Patch owned governance sections. |
| `templates/project/notes/implemented/AGENTS.md` | `.ai-workflow/notes/implemented/AGENTS.md` | Patch owned governance sections. |
| `templates/project/notes/archived/AGENTS.md` | `.ai-workflow/notes/archived/AGENTS.md` | Patch owned governance sections. |
| `templates/project/navigation.json` | `.ai-workflow/index/navigation.json` | Initialization generates project navigation; synchronization preserves it. |
| `templates/project/navigation.md` | `.ai-workflow/index/navigation.md` | Initialization renders project navigation; synchronization preserves it. |
| `templates/project/notes/archived/manifest.json` | `.ai-workflow/notes/archived/manifest.json` | Preserve a valid existing manifest; create the empty manifest only as safe missing management structure. |

For an unmarked legacy file, a same-heading section gains markers only when its body exactly matches the current template after excluding the new markers; a differing or unknown unmarked section is preserved rather than duplicated and is reported with `needs_attention`, and a clearly absent section is inserted with markers once. Only these supported destinations are writable. Navigation, note bodies, sealed archive data, frozen plans, `project.yml` and root `AGENTS.md`/`CLAUDE.md` user instructions are never merge input and stay byte-identical, and note triplets are handled as data rather than template input. A retired source artifact preserves its existing target and warns instead of deleting it, the precise `.gitignore` reconciliation and the missing notes-management directories are the only structural additions, and an unsupported destination never expands the writable set.

`ai-workflow install` additionally registers only owned native entries — the auto-loaded OpenCode plugin `.config/opencode/plugins/ai-workflow-sync.js`, and context plus `PreToolUse` hook commands in `~/.claude/settings.json` and `~/.codex/hooks.json` — each invoking `ai-workflow sync-hook --host <host>`, which reads the host's native JSON payload on stdin. Automatic synchronization runs exactly once per adopted actual root, when the planning, coding or plan-to-tasks skill session begins, through `ai-workflow sync-hook --host <current-host> --phase --project <actual-root>`; that check stores the complete result for the actual root outside the project. Every later native `SessionStart`, `UserPromptSubmit` and `PreToolUse` event returns only the stored result and issues zero source requests, and a session, resume, user-turn or actual-root change never invalidates or refreshes it; the next skill start atomically replaces the stored result. A missing, corrupt or unreadable stored check allows ordinary work with a visible no-freshness context and writes nothing, while `skip` means no adoption was found. The `--phase` form on every host, and the OpenCode stdin gate, print the raw gate JSON: a top-level `decision` of `allow`, `deny` or `skip`, `project`, `context`, optional `authority`, and an optional nested `report` with `status`, `verified` and `proceed`. The Claude Code and Codex stdin gates instead emit host-native output: `systemMessage`, and `hookSpecificOutput` with `hookEventName`, `additionalContext` plus `permissionDecision`/`permissionDecisionReason` on a `PreToolUse` deny; a `UserPromptSubmit` block carries a top-level `decision` of `block` with `reason`. These native gates never expose the raw `allow`/`deny`/`skip` decision. Every handled form exits 0 even on a deny, so the host follows its protocol rather than the exit code. The manual `ai-workflow sync` command remains a fresh, cache-independent synchronization that never replaces the stored gate decision; instead it prints a `SyncReport` with `status`, `verified` and `proceed` and no `decision`.

Installation reports a deployment per host with `active: false` and a status of `installed`, `trust_required`, `restart_required`, `disabled` or `needs_attention`; a disabled, untrusted or unloaded entry is not active and is never auto-approved. Codex hooks require human review and trust through `/hooks` with no bypass, OpenCode requires quitting and restarting the host, and Claude Code loading in an existing session is unverified until a new session. A hook that fails open on a host crash or timeout is reported as an enforcement limitation rather than successful blocking. This preflight is a narrow instruction-maintenance exception: it writes only the managed workflow instruction files of the actual current project root or the active coding worktree, performs no Git, no staging and no product edit, and never synchronizes frozen plans or their write scopes. It discloses every created or updated dirty path, and a clean-baseline or frozen-scope collision produces a bounded support request instead of silent staging or broader authority.

A host-scoped duplicate or shadowing copy of the shared synchronization skill is preserved and reported so the user can resolve it explicitly once; this one-time local cleanup never blind-deletes an unowned skill and does not change the user's HOME automatically. Until the marked templates are published to `hengboy/ai-workflow` branch `simplify`, a real remote attempt against the current upstream remains `unverified` with a warning and zero `created`/`updated` and makes no managed-freshness claim; publishing those templates upstream is outside this plan's authorization. A live three-host smoke installed all entries into a disposable HOME on Node 22, where the CLI `init`/`install` and the freshly built gate passed: OpenCode auto-loaded the initializer and resolved the real SDK session directory, but a model `401` before any chat, system or tool hook left tool enforcement unverified; Claude Code needed interactive authentication that was not used; and Codex required hook trust with no TTY and no bypass. The loaders are therefore installed and initializer-loaded only, never claimed automatically active.

### Change routing

Every request is classified before work starts, and the class decides the workflow. A direct change — a small requirement, feature adjustment or defect fix with clear, bounded intent and one observable outcome — is implemented directly without Planning, without `spec.md`, `plan.md` or task files, and without the dual-axis review. A mechanical change — typo, copy, comment, formatting or test-only adjustment with no observable behavior change — runs only the narrowest relevant check. A planned change — new feature, unclear or contested requirements, more than one materially different design, or a change to a public interface, persistent format, cross-module or cross-stack behavior, migration, compatibility or the project contract — runs Planning first, implements the frozen plan, and keeps the dual-axis review gate. Direct and mechanical changes still execute as one coding execution unit with its worktree and Git Operator commit; only the planning artifacts and the dual-axis review are skipped. A coding session that finds a planned change without a frozen plan runs Planning and then stops, so a planning session never continues into implementation: it reports the frozen plan path and the `plan validate` result, and when the plan declares at least one non-root participating repository it routes to a new session at the workspace root that invokes plan-to-tasks with the absolute frozen plan directory and then runs `ai-workflow workspace distribute --plan <directory>` before implementation, while an ordinary or root-only plan tells the user to start a new session and invoke the coding skill to implement it. The same classification is stated in `templates/project/AGENTS.md` and the `coding` and `planning` skills.

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

### Skill installation and local backups

Skills are installed once and host-neutral from `templates/skills/` under `~/.agents/skills`, rendered recursively and independent of the requested host list. OpenCode discovers skills recursively under that directory, so a same-named copy nested inside it — for example under `.backups/` — may override the canonical skill with the same declared `name`; the other hosts read the shared directory as their skill facts. A stale original skill copy is a local-machine condition, not product behavior, and such duplicates must be removed locally. Removing this machine's duplicated backup copies after an install or refresh is a one-time local cleanup and is not a permanent automatic deletion feature; the installer does not delete backups.

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

Navigation is JSON-authoritative version-1 output produced by a single builder, and `.ai-workflow/index/navigation.md` is rendered exclusively from that JSON. Validation dispatches by capability: structural roots are checked for file existence and coverage, while semantic roots are checked for exported symbols and import relations. `context validate`, `context locate --feature <id> --verify` and the authorized `context refresh` (which reuses the same adapters and preserves structural coverage) all operate on the generated navigation. A language that claims the semantic `exported-symbol` capability without a supported parser is rejected. `ai-workflow context rebuild --project <root>` re-scans the project through the same builder and validates the rebuilt index before anything is written; `--write` atomically replaces `navigation.json` and `navigation.md`, while a dry run reports the verdict untouched.

### Workspaces

A workspace is a root repository that composes child repositories as local git submodules, and `.gitmodules` is the sole boundary signal: every declared submodule path is excluded from the workspace root's navigation discovery and validation, so a child's files, symbols and state never enter the root index. A workspace navigation generated before this boundary existed keeps its bytes until `ai-workflow context rebuild --project <root> --write` refreshes the pair; `context validate` reports each indexed submodule path with that exact instruction instead of failing silently, and a project without `.gitmodules` keeps its previous discovery and validation behavior unchanged.

The workspace plan is one frozen bilingual `spec.md`/`plan.md` pair in the workspace root whose frontmatter declares `workspace_repos` — the participating repositories, their workspace-root-relative paths and the repository-level delivery order — and `workspace.yaml` assigns every task to exactly one repository. `ai-workflow workspace distribute --plan <directory>` writes a self-contained slice into each participating repository: the frozen planning triplets, that repository's task triplets, its filtered execution order and the `slice` manifest. It refuses divergent slice files before writing anything, and the reserved `workspace` root entry is skipped because the root's own tasks stay in the root plan. A workspace plan that declares at least one non-root participating repository must be split by plan-to-tasks before implementation: Planning ends it by routing to a new session at the workspace root that invokes plan-to-tasks with the absolute frozen plan directory, and completing that split runs `ai-workflow workspace distribute --plan <directory>` after the task triplets, their pair records and `workspace.yaml` are written and `plan validate` passes; a plan whose `workspace_repos` declares only the reserved `workspace` root entry may be implemented unsplit. When the plan activates the parent workspace boundary — a frozen plan that declares at least one participating non-root repository matched to the current root's `.gitmodules` — the one primary parent Coding session owns the execution: it invokes plan-to-tasks as an approved preparation procedure that returns control to the same session, distributes the slices, and then directly dispatches native leaves. Each active repository gets exactly one run-owned worktree at `<source-root>/.worktrees/<planId>` on branch `ai-workflow/<planId>`, where its tasks, validation, implementation record and delivery commit live; the parent worktree is not a container for child implementation. An ordinary plan, a project with `.gitmodules` running a non-participating plan, and a root-only workspace plan keep the ordinary route unchanged.

The primary keeps the original parent `tasks/execution-order.yaml` as the only global schedule: it dispatches a phase's independent tasks concurrently, awaits and verifies the whole phase before its scoped task commits are written serially, and completes a repository's per-repository delivery review and delivery gate before a dependent repository advances. It writes each repository's single `implementation.yaml` only through the filesystem-only `ai-workflow workspace checkpoint --plan <directory> --repo <name>` command, which accepts exactly one JSON event on stdin (`start`, `task`, `reviewed`, `delivered` or `finalized`), rejects unknown fields, wrong types, a wrong plan or repository, unauthorized task IDs, contradictory duplicates, invalid transitions and malformed full SHAs before writing, is idempotent for identical repeats, and leaves the prior record byte-unchanged on refusal. The record keeps only the `in-progress` and `completed` statuses and adds an `execution` anchor (`purpose`, `source_root`, `repository`, absolute `worktree`, `branch`, `target_branch`, `base_commit`), per-task `task_checkpoints` (`kind: commit` with a full SHA, or `kind: no-change` with the exact HEAD) and a purpose-scoped `reviewed_commit`. Finalization is a separate finalization review after every child and the root prefix are delivered, and the already-running correct root session executes it directly instead of reopening itself.

Automatic resume is limited to a clean, fully checkpointed phase boundary or a verified repository delivery boundary; a dirty partial phase, a commit-without-checkpoint gap, unknown future-phase progress, an uncertain review result, a contradictory record or an unrelated target drift stops with a bounded support or recovery request rather than redispatching a task. The CLI, real-Git and shipped-content tests cover this delivered scope, but the three-host native acceptance (an actual parent OpenCode, Claude Code and Codex session with disposable fixtures and HOME) is not fully demonstrated; the native parent-to-leaf delegation remains an explicitly reported gap rather than a claimed pass, and unavailable authentication or trust is not treated as success.

`ai-workflow workspace distribute --plan <directory>` reports each participating repository as `slices[].state` `written` or `unchanged` and the reserved root as `workspace_root_entry.state` `workspace-root` (it writes no root slice). `ai-workflow workspace status --plan <directory>` validates the workspace manifest against the frozen plan, tasks and `tasks/execution-order.yaml` before it reports `valid: true`, then reports read-only and without writing each non-root `repositories[]` entry with `slice` (`missing`, `divergent` or `present`), `record` (`missing`, `in-progress` or `completed`) and a nullable `delivery_commit`, a `workspace_root_entry` with `record`, `tasks_delivered` and a nullable `delivery_commit`, and an `order` and `next_repository` that follow the frozen `tasks/execution-order.yaml` repository first-appearance order including the pending `workspace` root tasks, plus `ready_for_finalization`. A divergent manifest fails with errors and changes no bytes. Readiness stays filesystem-only: a child counts as delivered only when its `record` is `completed`, its slice is `present`, its `plan_id` matches and its `delivery_commit` is a full commit SHA, and `ready_for_finalization` combines every such child with the root `tasks_delivered`; the root Git Operator still verifies every `delivery_commit` with a read-only `git cat-file -e <sha>^{commit}` existence check in its source repository before any index mutation, and object existence is not ref reachability. Read the report against the original parent workspace plan directory (`<workspace-plan-directory>`), never a slice; the next Coding session's working directory is `<repository-root>` (the workspace root for a root-owned task, otherwise the workspace-root-joined repo path) and its local frozen plan directory is `<repository-plan-directory>` (the parent plan for a root-owned task, otherwise the child's `.ai-workflow/plans/<planId>`), with prompts using the actual absolute paths, quoting any path argument that contains spaces, and the user's language. Root-owned tasks keep their frozen execution-order place and can precede dependent children. The already-running correct root finalization session performs the finalization directly, without telling the user to reopen itself; it pins each affected submodule inside the workspace worktree with `git update-index --cacheinfo 160000,<sha>,<path>` and stages only the authorized pointer paths and workspace-root files.

Note ownership splits with the boundary: the workspace root owns the cross-repository decision note, each repository owns the note covering the facts it delivered, and cross-repository references stay plain plan-ID text, so each side updates only its own notes and `MEMORY.md`. Planning keeps the reserved `workspace` root a dependency-free `prefix` whose tasks are delivered separately from finalization, requires cross-repository acceptance criteria to name their owning repository with exact bounded read-only source checks, and never checks out a child automatically.

### Implementation record

Coding writes the single permitted run record at `<project>/.ai-workflow/plans/<planId>/implementation.yaml`.

Before the first implementation step it holds `plan_id` with `status: in-progress` and an ISO 8601 `started_at` in the UTC+08:00 timezone and no `completed_at`. After the final merge and the cleanup of only the run-owned worktree and branch it becomes `status: completed` with an ISO 8601 `completed_at` in the UTC+08:00 timezone and the final commit SHA, preserving `plan_id` and `started_at`.

A workspace plan's root record may additionally carry an optional `root_tasks_commit`, a full lowercase 40- or 64-hex commit SHA. After the root-owned task prefix merges and its owned worktree is cleaned, the record stays `status: in-progress` with `root_tasks_commit` and no `completed_at` or `commit`, and only the finalization rewrites it to `completed` with `completed_at` and the final commit; an interrupted finalization retains `root_tasks_commit`. A valid `root_tasks_commit` is preferred as the root delivery evidence over a completed root record's `commit` fallback, but `workspace status` checks only its syntax; Git verifies the object at the final gate.

The record has only the two status values `in-progress` and `completed`; an interrupted run stays at `in-progress` with only the start fields and, once root delivery has occurred, `root_tasks_commit`, and no failure reason. Only a frozen plan creates this record, and coding creates no other workflow manifest or run record. `ai-workflow plan validate --plan <directory>` and `ai-workflow plan pairing --plan <directory>` neither require nor read this file.

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
