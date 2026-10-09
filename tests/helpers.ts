import { chmod, mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { renderMarkdown } from '../src/utils/frontmatter.js';
import { renderFrozenMarkdown } from '../src/workflow/digest.js';
import { renderNavigation, type NavigationIndex } from '../src/context/navigation.js';
import { blobHash, chineseSwitcher, englishSwitcher, metaPathOf, renderPairMeta, zhPathOf } from '../src/notes/pairing.js';
const exec = promisify(execFile);
export async function temporary(prefix = 'ai-workflow-'): Promise<string> { return mkdtemp(join(tmpdir(), prefix)); }

export function insertSwitcher(note: string, switcher: string): string {
  const lines = note.split('\n');
  const status = lines.findIndex((line) => line.startsWith('Status:'));
  let cursor = status === -1 ? 1 : status + 1;
  if (lines[cursor]?.startsWith('Archived:')) cursor += 1;
  return [...lines.slice(0, cursor + 1), switcher, '', ...lines.slice(cursor + 1)].join('\n');
}

export function notePair(englishPath: string, englishBody: string): { english: string; chinese: string; meta: string } {
  const english = insertSwitcher(englishBody, englishSwitcher(englishPath));
  const chinese = insertSwitcher(englishBody, chineseSwitcher(englishPath));
  return { english, chinese, meta: renderPairMeta(englishPath, blobHash(english), blobHash(chinese)) };
}

export async function writeNoteTriplet(root: string, englishPath: string, englishBody: string): Promise<{ english: string; chinese: string; meta: string }> {
  const files = notePair(englishPath, englishBody);
  await mkdir(join(root, englishPath).replace(/\/[^/]+$/, ''), { recursive: true });
  await writeFile(join(root, englishPath), files.english);
  await writeFile(join(root, zhPathOf(englishPath)), files.chinese);
  await writeFile(join(root, metaPathOf(englishPath)), files.meta);
  return files;
}

export type EnglishDocumentRenderer = (body: string) => string;

export interface PlanTripletFiles { english: string; chinese: string; meta: string }

/** Insert the exact language switcher after the document title, keeping it on line index 2. */
function insertTitleSwitcher(body: string, switcher: string): string {
  const lines = body.split('\n');
  const title = lines[0] ?? '';
  let cursor = 1;
  while (lines[cursor] === '') cursor += 1;
  return [title, '', switcher, '', ...lines.slice(cursor)].join('\n');
}

/** Render the planning-artifact consistency record: header comments plus exactly two hash lines. */
export function renderPlanPairMeta(planDirectory: string, englishBasename: string, englishHash: string, zhHash: string): string {
  const zhBasename = basename(zhPathOf(englishBasename));
  return [
    `# Bilingual-pair consistency record for the planning artifact triplet in ${planDirectory}.`,
    '# The two lines below pin the git blob hash of each side at the last confirmed-consistent state.',
    '# After editing either side, bring the other along and re-record with:',
    `# ai-workflow plan pairing --plan ${planDirectory} --write ${englishBasename}`,
    `${englishBasename}: ${englishHash}`,
    `${zhBasename}: ${zhHash}`,
    '',
  ].join('\n');
}

/** Render the frozen `tasks/execution-order.yaml` schedule a split-plan fixture must carry. */
export function renderExecutionOrderYaml(planId: string, phases: string[][]): string {
  const lines = [`plan_id: ${planId}`, 'phases:'];
  for (const phase of phases) {
    lines.push('  - parallel:');
    for (const id of phase) lines.push(`      - ${id}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Build the English and Chinese sides plus the consistency record for one planning document. */
export function planDocumentPair(
  planDirectory: string,
  englishBasename: string,
  englishBody: string,
  chineseBody: string,
  renderEnglish: EnglishDocumentRenderer = (body) => body,
): PlanTripletFiles {
  const english = renderEnglish(insertTitleSwitcher(englishBody, englishSwitcher(englishBasename)));
  const chinese = insertTitleSwitcher(chineseBody, chineseSwitcher(englishBasename));
  return { english, chinese, meta: renderPlanPairMeta(planDirectory, englishBasename, blobHash(english), blobHash(chinese)) };
}

/** Write a complete `<doc>.md` / `<doc>.zh.md` / `<doc>.i18n.yaml` triplet for a plan document. */
export async function writePlanTriplet(
  planDirectory: string,
  englishBasename: string,
  englishBody: string,
  chineseBody: string,
  renderEnglish: EnglishDocumentRenderer = (body) => body,
): Promise<PlanTripletFiles> {
  const files = planDocumentPair(planDirectory, englishBasename, englishBody, chineseBody, renderEnglish);
  await mkdir(planDirectory, { recursive: true });
  await writeFile(join(planDirectory, englishBasename), files.english);
  await writeFile(join(planDirectory, zhPathOf(englishBasename)), files.chinese);
  await writeFile(join(planDirectory, metaPathOf(englishBasename)), files.meta);
  return files;
}

/** Re-record the current bytes of an existing plan document pair. */
export async function recordPlanPair(planDirectory: string, englishBasename: string): Promise<void> {
  const english = await readFile(join(planDirectory, englishBasename));
  const chinese = await readFile(join(planDirectory, zhPathOf(englishBasename)));
  await writeFile(join(planDirectory, metaPathOf(englishBasename)), renderPlanPairMeta(planDirectory, englishBasename, blobHash(english), blobHash(chinese)));
}

export async function frozenPlan(root: string, withTasks = true): Promise<string> {
  const directory = join(root, '.ai-workflow/plans/20260831-example');
  await mkdir(join(directory, 'tasks'), { recursive: true });
  const attributes = { plan_id: '20260831-example', status: 'frozen', created_at: '2026-08-31T00:00:00.000Z', supersedes: null, requirement_count: 1, acceptance_criteria_count: 1, digest: 'sha256:placeholder' };
  const frozen: EnglishDocumentRenderer = (body) => renderFrozenMarkdown(attributes, body);
  await writePlanTriplet(directory, 'spec.md', '# Specification\n\n## REQ-001 Works\n\n## AC-001 Observable', '# Specification\n\n## REQ-001 Works\n\n## AC-001 Observable', frozen);
  await writePlanTriplet(directory, 'plan.md', '# Implementation Plan\n\nImplement REQ-001 and verify AC-001.', '# Implementation Plan\n\nImplement REQ-001 and verify AC-001.', frozen);
  if (withTasks) {
    const navigation: NavigationIndex = { version: 1, module_roots: [{ id: 'input', path: 'src', owner_role: 'backend', responsibility: 'test input', language: 'typescript', entry_kinds: ['exported-symbol'] }], features: [{ id: 'task-input', name: 'task input', aliases: [], module_root: 'input', entries: ['src/input.ts'], symbols: [], related_files: [], tests: [], depends_on: [], relations: [], owner_role: 'backend', responsibility: 'test input', read_scope: ['src/input.ts'], shared_entry: false }] };
    await mkdir(join(root, 'src'), { recursive: true }); await mkdir(join(root, '.ai-workflow/index'), { recursive: true });
    await writeFile(join(root, 'MEMORY.md'), '# Memory\n'); await writeFile(join(root, 'src/input.ts'), 'export const input = true;\n'); await writeFile(join(root, '.ai-workflow/index/navigation.json'), `${JSON.stringify(navigation)}\n`); await writeFile(join(root, '.ai-workflow/index/navigation.md'), renderNavigation(navigation));
    const task = { id: 'task-001-example', requirements: ['REQ-001'], acceptance_criteria: ['AC-001'], depends_on: [], surface: 'backend', read_scope: ['MEMORY.md', '.ai-workflow/index/navigation.json', '.ai-workflow/index/navigation.md', 'src/input.ts'], write_scope: ['src/output.ts'], test_commands: ['pnpm test'] };
    await writePlanTriplet(join(directory, 'tasks'), 'task-001-example.md', '# Task', '# Task', (body) => renderMarkdown(task, body));
    await writeFile(join(directory, 'tasks', 'execution-order.yaml'), renderExecutionOrderYaml('20260831-example', [['task-001-example']]));
  }
  return directory;
}
export async function gitInit(root: string): Promise<void> { await exec('git', ['init', '-b', 'main'], { cwd: root }); await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: root }); await exec('git', ['config', 'user.name', 'Test'], { cwd: root }); await exec('git', ['config', 'commit.gpgsign', 'false'], { cwd: root }); await writeFile(join(root, 'README.md'), '# Test\n'); await exec('git', ['add', 'README.md'], { cwd: root }); await exec('git', ['commit', '-m', 'initial'], { cwd: root }); }

/** One `workspace_repos` entry as it appears in the frozen plan.md frontmatter. */
export interface WorkspaceRepoFixture { name: string; path: string; dependsOn: string[] }

/** One task document in a workspace plan fixture; `repo` is omitted to model a missing repository. */
export interface WorkspaceTaskFixture {
  id: string;
  repo?: string;
  requirements: string[];
  acceptanceCriteria: string[];
  dependsOn?: string[];
  surface?: string;
  readScope?: string[];
  writeScope?: string[];
}

/** One repository entry of a `workspace.yaml` manifest. */
export interface WorkspaceManifestRepoFixture { name: string; path: string; dependsOn: string[]; requirements: string[]; acceptanceCriteria: string[] }

/** The `workspace.yaml` manifest payload a workspace or slice plan fixture carries. */
export interface WorkspaceManifestFixture { planId: string; role: 'workspace' | 'slice'; repositories: WorkspaceManifestRepoFixture[] }

/** One repository-qualified `read_scope` entry of a `workspace_finalization` declaration. */
export interface WorkspaceFinalizationReadScopeFixture { repo: string; paths: string[] }

/** The optional `workspace_finalization` plan.md frontmatter declaration. */
export interface WorkspaceFinalizationFixture {
  requirements: string[];
  acceptanceCriteria: string[];
  readScope: WorkspaceFinalizationReadScopeFixture[];
  writeScope: string[];
  testCommands?: string[];
}

/** A complete workspace plan fixture: frozen pair, task triplets, schedule and optional manifest. */
export interface WorkspacePlanFixtureSpec {
  planId: string;
  requirements: string[];
  acceptanceCriteria: string[];
  workspaceRepos?: WorkspaceRepoFixture[];
  tasks: WorkspaceTaskFixture[];
  phases: string[][];
  manifest?: WorkspaceManifestFixture;
  workspaceFinalization?: WorkspaceFinalizationFixture;
  /** A raw `workspace_finalization` value, used to exercise malformed declarations. */
  workspaceFinalizationRaw?: unknown;
}

function workspaceSpecBody(requirements: string[], acceptanceCriteria: string[], prose: (id: string) => string): string {
  return [
    '# Specification',
    '',
    ...requirements.flatMap((id) => [`## ${id}: requirement`, '', prose(id), '']),
    ...acceptanceCriteria.flatMap((id) => [`## ${id}: acceptance criteria`, '', prose(id), '']),
    '',
  ].join('\n');
}

function workspacePlanBody(requirements: string[], acceptanceCriteria: string[], step: (id: string) => string): string {
  return [
    '# Implementation Plan',
    '',
    '## Requirement coverage',
    '',
    '| Requirement | Acceptance criteria | Implementation step |',
    '| --- | --- | --- |',
    ...requirements.map((id, index) => `| ${id} | ${acceptanceCriteria[index] ?? ''} | ${step(id)} |`),
    '',
    '## Implementation sequence',
    '',
    ...requirements.map((id, index) => `${index + 1}. ${step(id)}`),
    '',
  ].join('\n');
}

/** Render the deterministic YAML body of a `workspace.yaml` manifest fixture. */
export function renderWorkspaceManifestYaml(manifest: WorkspaceManifestFixture): string {
  const lines = [`plan_id: ${manifest.planId}`, `role: ${manifest.role}`, 'repositories:'];
  for (const repo of manifest.repositories) {
    lines.push(`  - name: ${repo.name}`);
    lines.push(`    path: ${repo.path}`);
    lines.push(`    depends_on: [${repo.dependsOn.join(', ')}]`);
    lines.push(`    requirements: [${repo.requirements.join(', ')}]`);
    lines.push(`    acceptance_criteria: [${repo.acceptanceCriteria.join(', ')}]`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Write a complete workspace plan fixture under `<root>/.ai-workflow/plans/<planId>`:
 * the frozen spec/plan pair (with an optional `workspace_repos` declaration), the task
 * triplets, `tasks/execution-order.yaml` and, when supplied, `workspace.yaml`.
 */
export async function workspacePlanFixture(root: string, spec: WorkspacePlanFixtureSpec): Promise<string> {
  const directory = join(root, '.ai-workflow/plans', spec.planId);
  await mkdir(join(directory, 'tasks'), { recursive: true });
  const baseAttributes: Record<string, unknown> = {
    plan_id: spec.planId,
    status: 'frozen',
    created_at: '2026-09-30T00:00:00.000Z',
    supersedes: null,
    requirement_count: spec.requirements.length,
    acceptance_criteria_count: spec.acceptanceCriteria.length,
    digest: 'sha256:placeholder',
  };
  const planAttributes: Record<string, unknown> = { ...baseAttributes };
  if (spec.workspaceRepos) planAttributes.workspace_repos = spec.workspaceRepos.map((repo) => ({ name: repo.name, path: repo.path, depends_on: repo.dependsOn }));
  if (spec.workspaceFinalization) planAttributes.workspace_finalization = {
    requirements: spec.workspaceFinalization.requirements,
    acceptance_criteria: spec.workspaceFinalization.acceptanceCriteria,
    read_scope: spec.workspaceFinalization.readScope.map((entry) => ({ repo: entry.repo, paths: entry.paths })),
    write_scope: spec.workspaceFinalization.writeScope,
    test_commands: spec.workspaceFinalization.testCommands ?? [],
  };
  if (spec.workspaceFinalizationRaw !== undefined) planAttributes.workspace_finalization = spec.workspaceFinalizationRaw;
  await writePlanTriplet(
    directory,
    'spec.md',
    workspaceSpecBody(spec.requirements, spec.acceptanceCriteria, (id) => `${id} prose.`),
    workspaceSpecBody(spec.requirements, spec.acceptanceCriteria, (id) => `${id} 正文。`),
    (body) => renderFrozenMarkdown(baseAttributes, body),
  );
  await writePlanTriplet(
    directory,
    'plan.md',
    workspacePlanBody(spec.requirements, spec.acceptanceCriteria, (id) => `Implement ${id}.`),
    workspacePlanBody(spec.requirements, spec.acceptanceCriteria, (id) => `实现 ${id}。`),
    (body) => renderFrozenMarkdown(planAttributes, body),
  );
  for (const task of spec.tasks) {
    const attributes: Record<string, unknown> = {
      id: task.id,
      requirements: task.requirements,
      acceptance_criteria: task.acceptanceCriteria,
      depends_on: task.dependsOn ?? [],
      surface: task.surface ?? 'backend',
      read_scope: task.readScope ?? ['MEMORY.md'],
      write_scope: task.writeScope ?? [`src/${task.id}.ts`],
      test_commands: ['pnpm test'],
    };
    if (task.repo !== undefined) attributes.repo = task.repo;
    await writePlanTriplet(join(directory, 'tasks'), `${task.id}.md`, '# Task', '# Task', (body) => renderMarkdown(attributes, body));
  }
  await writeFile(join(directory, 'tasks', 'execution-order.yaml'), renderExecutionOrderYaml(spec.planId, spec.phases));
  if (spec.manifest) await writeFile(join(directory, 'workspace.yaml'), renderWorkspaceManifestYaml(spec.manifest));
  return directory;
}

/** Recursively hash every regular file and symlink under `root`, skipping `.git` entries. */
export async function snapshotTree(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const absolute = join(directory, entry.name);
      const key = relative(root, absolute).split(sep).join('/');
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isSymbolicLink()) snapshot.set(key, 'symlink');
      else if (entry.isFile()) snapshot.set(key, createHash('sha256').update(await readFile(absolute)).digest('hex'));
    }
  }
  await walk(root);
  return snapshot;
}

/** Project-relative paths whose bytes differ between two `snapshotTree` results, sorted. */
export function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => before.get(path) !== after.get(path)).sort();
}

async function gitInitRepository(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await exec('git', ['init', '-b', 'main'], { cwd: directory });
  await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: directory });
  await exec('git', ['config', 'user.name', 'Test'], { cwd: directory });
  await exec('git', ['config', 'commit.gpgsign', 'false'], { cwd: directory });
}

async function gitCommitAll(directory: string, message: string): Promise<void> {
  await exec('git', ['add', '-A'], { cwd: directory });
  await exec('git', ['commit', '-m', message], { cwd: directory });
}

/** One participating child repository of a real-git workspace fixture; `init` defaults to true. */
export interface RealWorkspaceRepoSpec { name: string; path: string; init?: boolean }

/** A materialized child repository of a real-git workspace fixture. */
export interface RealWorkspaceRepo { name: string; path: string; absolute: string }

/**
 * Build a real workspace root whose `.gitmodules` declares each `repos` entry as a
 * local git submodule, using the repository name as the submodule section name. Each
 * repository (`init !== false`) and the workspace root are initialized as ai-workflow
 * projects with the CLI, and every initialized child is committed so
 * `git status --porcelain` is clean. Local file-protocol submodules are used so the
 * fixture stays offline.
 */
export async function realWorkspaceFixture(repos: RealWorkspaceRepoSpec[]): Promise<{ root: string; repos: RealWorkspaceRepo[] }> {
  const root = await temporary('ai-workflow-real-workspace-');
  await gitInitRepository(root);
  await writeFile(join(root, 'README.md'), '# Workspace\n');
  await gitCommitAll(root, 'workspace initial');

  for (const repo of repos) {
    const source = await temporary('ai-workflow-real-child-');
    await gitInitRepository(source);
    await mkdir(join(source, 'src'), { recursive: true });
    await writeFile(join(source, 'src', 'index.ts'), 'export const childEntry = true;\n');
    await gitCommitAll(source, 'child initial');
    await exec('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--name', repo.name, source, repo.path], { cwd: root });
  }
  await gitCommitAll(root, 'add submodules');

  const initialized = repos.filter((repo) => repo.init !== false);
  await Promise.all(
    [root, ...initialized.map((repo) => join(root, repo.path))].map((target) =>
      exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'init', target], { maxBuffer: 10 * 1024 * 1024 }),
    ),
  );
  for (const repo of initialized) await gitCommitAll(join(root, repo.path), 'initialize project');

  return { root, repos: repos.map((repo) => ({ name: repo.name, path: repo.path, absolute: join(root, repo.path) })) };
}

/**
 * Write a file inside an existing repository, stage exactly that path and commit it.
 * Returns the full 40-hex commit SHA. Used by the real-Git lifecycle fixtures to create
 * commit-local, dependency-free delivery commits.
 */
export async function commitFile(repository: string, relativePath: string, contents: string, message: string): Promise<string> {
  const absolute = join(repository, relativePath);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
  await exec('git', ['add', '--', relativePath], { cwd: repository });
  await exec('git', ['commit', '-m', message], { cwd: repository });
  const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: repository });
  return stdout.trim();
}

// --- Fake production git source acquisition -----------------------------------------

/** A `runGit`-shaped test double: the production `GitRunner` contract. */
export type TestGitRunner = (arguments_: string[]) => Promise<{ stdout: string }>;

/** Mutable fake-git state: the immutable head to report and the file bytes to materialize. */
export interface FakeGitState {
  commit: string;
  files: Record<string, string>;
}

/** A reusable fake production git runner plus the invocations it observed. */
export interface FakeGit {
  runGit: TestGitRunner;
  /** Every invocation's argument vector, in order. */
  calls: string[][];
  /** The clone destination (last clone argument) of every clone, in order. */
  clones: string[];
  cloneCount: () => number;
  invocationCount: () => number;
}

/**
 * Build a small fake production git runner. On `clone` it records the destination (the last
 * argument), writes `state.files` beneath it, and returns empty stdout. On `-C <dir> rev-parse
 * HEAD` it returns `state.commit` newline-terminated. Any other invocation throws, so an
 * unexpected production call is a test failure rather than a silent pass.
 */
export function fakeGit(state: FakeGitState): FakeGit {
  const calls: string[][] = [];
  const clones: string[] = [];
  const runGit = async (arguments_: string[]): Promise<{ stdout: string }> => {
    calls.push([...arguments_]);
    if (arguments_[0] === 'clone') {
      const destination = arguments_[arguments_.length - 1];
      if (destination === undefined) throw new Error(`Unexpected git clone without a destination: ${arguments_.join(' ')}`);
      clones.push(destination);
      for (const [relative, contents] of Object.entries(state.files)) {
        const target = join(destination, relative);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, contents);
      }
      return { stdout: '' };
    }
    if (arguments_[0] === '-C' && arguments_[2] === 'rev-parse' && arguments_[3] === 'HEAD') {
      return { stdout: `${state.commit}\n` };
    }
    throw new Error(`Unexpected git invocation: ${arguments_.join(' ')}`);
  };
  return { runGit, calls, clones, cloneCount: () => clones.length, invocationCount: () => calls.length };
}

/**
 * The executable `git` shim integration subprocess tests place earlier in `PATH`. It reads the
 * fixture named by `AI_WORKFLOW_GIT_FIXTURE`, selects the head from `AI_WORKFLOW_FIXTURE_HEAD`,
 * logs the head to `AI_WORKFLOW_FIXTURE_LOG` on every clone, materializes the fixture files into
 * the clone destination, answers `-C <dir> rev-parse HEAD`, and can fail a clone after logging.
 */
export const GIT_SHIM_SOURCE = `#!/usr/bin/env node
const { mkdirSync, appendFileSync, writeFileSync, readFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const args = process.argv.slice(2);
const head = process.env.AI_WORKFLOW_FIXTURE_HEAD || '${'a'.repeat(40)}';
const log = process.env.AI_WORKFLOW_FIXTURE_LOG;
if (args[0] === 'clone') {
  if (log) appendFileSync(log, head + '\\n');
  const fixturePath = process.env.AI_WORKFLOW_GIT_FIXTURE;
  const fixture = fixturePath ? JSON.parse(readFileSync(fixturePath, 'utf8')) : { files: {} };
  if (fixture.fail) { process.stderr.write(String(fixture.fail) + '\\n'); process.exit(1); }
  for (const [path, contents] of Object.entries(fixture.files || {})) {
    const target = join(args[args.length - 1], path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  process.exit(0);
}
if (args[0] === '-C' && args[2] === 'rev-parse' && args[3] === 'HEAD') {
  process.stdout.write(head + '\\n');
  process.exit(0);
}
process.stderr.write('unexpected git invocation: ' + args.join(' ') + '\\n');
process.exit(2);
`;

/** The fixture the `git` shim reads: the source files to materialize, or a clone failure reason. */
export interface GitShimFixture { files: Record<string, string>; fail?: string }

/** Write the `git` shim into a fresh temp bin directory, executable, for PATH prepending. */
export async function writeGitShim(): Promise<string> {
  const directory = await temporary('ai-workflow-git-shim-');
  const shim = join(directory, 'git');
  await writeFile(shim, GIT_SHIM_SOURCE);
  await chmod(shim, 0o755);
  return directory;
}

/** Write the JSON fixture the `git` shim reads from `AI_WORKFLOW_GIT_FIXTURE`. */
export async function writeGitFixture(directory: string, fixture: GitShimFixture, name = 'fixture.json'): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, JSON.stringify(fixture));
  return path;
}

/** Prepend the shim directory to `PATH` and point the shim at its fixture, keeping the rest of `env`. */
export function withGitShim(env: NodeJS.ProcessEnv, binDirectory: string, fixturePath: string): NodeJS.ProcessEnv {
  return {
    ...env,
    PATH: `${binDirectory}${delimiter}${env.PATH ?? process.env.PATH ?? ''}`,
    AI_WORKFLOW_GIT_FIXTURE: fixturePath,
  };
}
