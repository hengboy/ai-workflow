import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { SyncReport } from '../../src/sync/index.js';
import { exists } from '../../src/utils/fs.js';
import { changedPaths, snapshotTree, temporary, withGitShim, writeGitFixture, writeGitShim } from '../helpers.js';

const exec = promisify(execFile);

// The worktree root and its tsx loader entry, so the CLI runs as a real subprocess.
const repoRoot = process.cwd();
const tsxLoader = pathToFileURL(join(repoRoot, 'node_modules/tsx/dist/loader.mjs')).href;
const cliEntry = join(repoRoot, 'src/cli.ts');

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const commit = 'e'.repeat(40);

const generatedTargets = [
  '.ai-workflow/AGENTS.md',
  '.ai-workflow/notes/AGENTS.md',
  '.ai-workflow/notes/README.md',
  '.ai-workflow/notes/implemented/AGENTS.md',
  '.ai-workflow/notes/archived/AGENTS.md',
] as const;

const navigationJson = `${JSON.stringify({ version: 1, module_roots: [], features: [] }, null, 2)}\n`;
const manifestJson = '{\n  "version": 1,\n  "files": {}\n}\n';

// Source fixture: exactly five markerless generated documents materialized by the git shim.
const sourceAgents = '# ai-workflow project contract\n\nFresh contract body.\n';
const sourceNotesAgents = '# Agent Notes instructions\n\nFresh notes instructions.\n';
const sourceReadme = '# Agent Notes\n\nFresh notes readme.\n';
const sourceImplemented = '# Implemented notes instructions\n\nFresh implemented instructions.\n';
const sourceArchived = '# Archived notes instructions\n\nFresh archived instructions.\n';

const sourceFiles: Record<string, string> = {
  'templates/project/AGENTS.md': sourceAgents,
  'templates/project/notes/AGENTS.md': sourceNotesAgents,
  'templates/project/notes/README.md': sourceReadme,
  'templates/project/notes/implemented/AGENTS.md': sourceImplemented,
  'templates/project/notes/archived/AGENTS.md': sourceArchived,
};

const targetsToSource: Record<string, string> = {
  '.ai-workflow/AGENTS.md': sourceAgents,
  '.ai-workflow/notes/AGENTS.md': sourceNotesAgents,
  '.ai-workflow/notes/README.md': sourceReadme,
  '.ai-workflow/notes/implemented/AGENTS.md': sourceImplemented,
  '.ai-workflow/notes/archived/AGENTS.md': sourceArchived,
};

// Adopted target: every generated file is a stale markerless file that full replacement overwrites.
const targetAgents = '# ai-workflow project contract\n\nStale contract body.\n';
const targetNotesAgents = '# Agent Notes instructions\n\nStale notes instructions.\n';
const targetReadme = '# Agent Notes\n\nStale readme.\n';
const targetImplemented = '# Implemented notes instructions\n\nStale implemented instructions.\n';
const targetArchived = '# Archived notes instructions\n\nStale archived instructions.\n';

const memoryBytes = '# Project memory\r\n\r\nIndependent CRLF standard that must survive.\r\n';
const planSpecBytes = '# Frozen plan\n\nIndependent frozen plan bytes.\n';
const customNoteBytes = '# Custom note\n\nIndependent note bytes.\n';

interface CliResult { code: number; stdout: string; stderr: string }

async function runCli(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  try {
    const { stdout, stderr } = await exec(
      process.execPath,
      ['--import', tsxLoader, cliEntry, ...args],
      { cwd, maxBuffer: 10 * 1024 * 1024, env },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failure.code === 'number' ? failure.code : 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

interface GitFixture { binDirectory: string; fixturePath: string }

/** Plant the fake `git` earlier in PATH and a fixture file it reads, for one test run. */
async function gitFixture(fixture: { files: Record<string, string>; fail?: string }): Promise<GitFixture> {
  const binDirectory = await writeGitShim();
  const fixtureDirectory = await temporary('ai-workflow-sync-cli-fixture-');
  roots.push(binDirectory, fixtureDirectory);
  const fixturePath = await writeGitFixture(fixtureDirectory, fixture);
  return { binDirectory, fixturePath };
}

const sourceEnv = (git: GitFixture): NodeJS.ProcessEnv =>
  withGitShim({ ...process.env, AI_WORKFLOW_FIXTURE_HEAD: commit }, git.binDirectory, git.fixturePath);

async function adoptedProject(): Promise<string> {
  const root = await temporary('ai-workflow-sync-cli-');
  roots.push(root);
  await mkdir(join(root, '.ai-workflow/index'), { recursive: true });
  await mkdir(join(root, '.ai-workflow/plans/20260101-custom'), { recursive: true });
  await mkdir(join(root, '.ai-workflow/notes/implemented/feature'), { recursive: true });
  await mkdir(join(root, '.ai-workflow/notes/archived/architecture'), { recursive: true });
  await writeFile(join(root, '.ai-workflow/AGENTS.md'), targetAgents);
  await writeFile(join(root, '.ai-workflow/notes/AGENTS.md'), targetNotesAgents);
  await writeFile(join(root, '.ai-workflow/notes/README.md'), targetReadme);
  await writeFile(join(root, '.ai-workflow/notes/implemented/AGENTS.md'), targetImplemented);
  await writeFile(join(root, '.ai-workflow/notes/archived/AGENTS.md'), targetArchived);
  await writeFile(join(root, 'MEMORY.md'), memoryBytes);
  await writeFile(join(root, '.ai-workflow/index/navigation.json'), navigationJson);
  await writeFile(join(root, '.ai-workflow/index/navigation.md'), '# Navigation\n\nAdopted navigation.\n');
  await writeFile(join(root, '.ai-workflow/notes/archived/manifest.json'), manifestJson);
  await writeFile(join(root, '.ai-workflow/plans/20260101-custom/spec.md'), planSpecBytes);
  await writeFile(join(root, '.ai-workflow/notes/implemented/feature/2026-01-01-custom.md'), customNoteBytes);
  await writeFile(join(root, '.gitignore'), '.ai-workflow/plans/\n.worktrees/\n');
  return root;
}

function reportOf(result: CliResult): SyncReport {
  return JSON.parse(result.stdout) as SyncReport;
}

describe('project sync CLI', () => {
  it('maps check, apply, repeat and legacy refusal to JSON reports and exit severity from a nested cwd', async () => {
    const project = await adoptedProject();
    const git = await gitFixture({ files: sourceFiles });
    const env = sourceEnv(git);
    const nested = join(project, 'src/deep');
    await mkdir(nested, { recursive: true });
    const before = await snapshotTree(project);

    // Check from a nested cwd with the project omitted resolves the adopted root and proposes without writing.
    const check = await runCli(nested, ['sync', '--check'], env);
    expect(check.code).toBe(1);
    const pending = reportOf(check);
    expect(pending.status).toBe('pending');
    expect(pending.verified).toBe(false);
    expect(pending.proceed).toBe(false);
    expect(pending.check).toBe(true);
    expect(await realpath(pending.project)).toBe(await realpath(project));
    expect(pending.source).toEqual({ repository: 'hengboy/ai-workflow', branch: 'main', commit });
    expect([...pending.updated].sort()).toEqual([...generatedTargets].sort());
    expect(changedPaths(before, await snapshotTree(project)), 'check mode must write nothing').toEqual([]);

    // Apply replaces all five generated files with their complete source and preserves local/data bytes.
    const apply = await runCli(nested, ['sync'], env);
    expect(apply.code).toBe(0);
    const applied = reportOf(apply);
    expect(applied.status).toBe('synchronized');
    expect(applied.verified).toBe(true);
    expect(applied.proceed).toBe(true);
    expect(applied.check).toBe(false);
    expect(applied.source.commit).toBe(commit);
    expect([...applied.updated].sort()).toEqual([...generatedTargets].sort());
    expect(applied.created).toEqual([]);
    for (const [path, expected] of Object.entries(targetsToSource)) {
      expect(await readFile(join(project, path), 'utf8')).toBe(expected);
      expect(await readFile(join(project, path), 'utf8')).not.toMatch(/ai-workflow:section/);
    }
    expect(await readFile(join(project, 'MEMORY.md'), 'utf8')).toBe(memoryBytes);
    expect(await readFile(join(project, '.ai-workflow/plans/20260101-custom/spec.md'), 'utf8')).toBe(planSpecBytes);
    expect(await readFile(join(project, '.ai-workflow/notes/implemented/feature/2026-01-01-custom.md'), 'utf8')).toBe(customNoteBytes);

    // Repeating the same immutable source is idempotent.
    const repeat = await runCli(nested, ['sync'], env);
    expect(repeat.code).toBe(0);
    const repeated = reportOf(repeat);
    expect(repeated.status).toBe('synchronized');
    expect(repeated.updated).toEqual([]);
    expect(repeated.created).toEqual([]);

    // A generated target that still carries legacy section markers is refused with its path and no writes.
    const legacy = '# Project contract\n\n<!-- ai-workflow:section shared-context:begin -->\nold body\n<!-- ai-workflow:section shared-context:end -->\n';
    await writeFile(join(project, '.ai-workflow/AGENTS.md'), legacy);
    const conflictBefore = await snapshotTree(project);
    const conflict = await runCli(nested, ['sync'], env);
    expect(conflict.code).toBe(1);
    const blocked = reportOf(conflict);
    expect(blocked.status).toBe('conflict');
    expect(blocked.verified).toBe(false);
    expect(blocked.proceed).toBe(false);
    expect(blocked.conflicts.some((entry) => entry.path === '.ai-workflow/AGENTS.md')).toBe(true);
    expect(changedPaths(conflictBefore, await snapshotTree(project)), 'a conflict must write nothing').toEqual([]);
  });

  it('reports source failure as unverified exit 2 with zero target changes', async () => {
    const project = await adoptedProject();
    const git = await gitFixture({ files: {}, fail: 'rate limited' });
    const env = sourceEnv(git);
    const before = await snapshotTree(project);

    const result = await runCli(project, ['sync'], env);
    expect(result.code).toBe(2);
    const report = reportOf(result);
    expect(report.status).toBe('unverified');
    expect(report.verified).toBe(false);
    expect(report.proceed).toBe(true);
    expect(report.check).toBe(false);
    expect(report.source.commit).toBeNull();
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(changedPaths(before, await snapshotTree(project)), 'a source failure must write nothing').toEqual([]);
  });

  it('preserves root MEMORY that mentions legacy marker text and keeps the sync path normal', async () => {
    const project = await adoptedProject();
    const memory = '# Project memory\n\nHistorical prose mentioning <!-- ai-workflow:section standards:begin --> syntax.\n';
    await writeFile(join(project, 'MEMORY.md'), memory);
    const git = await gitFixture({ files: sourceFiles });
    const env = sourceEnv(git);

    const result = await runCli(project, ['sync'], env);

    expect(result.code).toBe(0);
    const report = reportOf(result);
    expect(report.status).toBe('synchronized');
    expect(report.updated).not.toContain('MEMORY.md');
    expect(await readFile(join(project, 'MEMORY.md'), 'utf8')).toBe(memory);
  });

  it('reports a prerequisite conflict without initializing a partial adoption and keeps update unavailable', async () => {
    const project = await temporary('ai-workflow-sync-cli-partial-');
    roots.push(project);
    await mkdir(join(project, '.ai-workflow'), { recursive: true });
    const git = await gitFixture({ files: sourceFiles });
    const env = sourceEnv(git);

    const result = await runCli(project, ['sync'], env);
    expect(result.code).toBe(1);
    const report = reportOf(result);
    expect(report.status).toBe('conflict');
    expect(report.conflicts.length).toBeGreaterThan(0);
    // No initialization: the missing prerequisite artifacts stay missing.
    expect(await exists(join(project, 'MEMORY.md'))).toBe(false);
    expect(await exists(join(project, '.ai-workflow/index/navigation.json'))).toBe(false);
    expect(await exists(join(project, '.ai-workflow/index/navigation.md'))).toBe(false);

    const removed = await runCli(project, ['update', project], env);
    expect(removed.code).not.toBe(0);
    expect(`${removed.stderr}${removed.stdout}`).toMatch(/unknown command/i);
  });
});
