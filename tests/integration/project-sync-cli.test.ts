import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { SyncReport } from '../../src/sync/index.js';
import { exists } from '../../src/utils/fs.js';
import { changedPaths, snapshotTree, temporary } from '../helpers.js';

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

function marker(id: string, body: string): string {
  return `<!-- ai-workflow:section ${id}:begin -->\n${body}\n<!-- ai-workflow:section ${id}:end -->\n`;
}

const navigationJson = `${JSON.stringify({ version: 1, module_roots: [], features: [] }, null, 2)}\n`;
const manifestJson = '{\n  "version": 1,\n  "files": {}\n}\n';
const notesGovernance = marker('notes-governance', 'Shared notes governance.');
const notesReadme = marker('notes-readme', 'Shared notes readme.');
const implementedGovernance = marker('implemented-governance', 'Shared implemented governance.');
const archivedGovernance = marker('archived-governance', 'Shared archived governance.');

// Source fixture: mandatory listing contract plus valid marked templates.
const sourceFiles: Record<string, string> = {
  'templates/project/AGENTS.md': `# Project contract\n${marker('shared-context', '## Shared context\nFresh shared context.')}`,
  'templates/project/MEMORY.md': `# Project memory\n${marker('standards', 'Fresh standards.')}`,
  'templates/project/navigation.json': navigationJson,
  'templates/project/navigation.md': '# Navigation\n\nAdopted navigation.\n',
  'templates/project/notes/AGENTS.md': notesGovernance,
  'templates/project/notes/README.md': notesReadme,
  'templates/project/notes/implemented/AGENTS.md': implementedGovernance,
  'templates/project/notes/archived/AGENTS.md': archivedGovernance,
  'templates/project/notes/archived/manifest.json': manifestJson,
};

const sourceDirectories: Record<string, readonly string[]> = {
  'templates/project': ['AGENTS.md', 'MEMORY.md', 'navigation.json', 'navigation.md', 'notes'],
  'templates/project/notes': ['AGENTS.md', 'README.md', 'implemented', 'archived'],
  'templates/project/notes/implemented': ['AGENTS.md'],
  'templates/project/notes/archived': ['AGENTS.md', 'manifest.json'],
};

// Adopted target: marked sections differ from source; custom bytes and independent
// data must survive.
const targetAgents = `custom preface\n${marker('shared-context', '## Shared context\nOld shared context.')}custom suffix\n`;
const expectedAgents = `custom preface\n${marker('shared-context', '## Shared context\nFresh shared context.')}custom suffix\n`;
const targetMemory = `# Project memory\n${marker('standards', 'Old standards.')}custom trailing note\n`;
const expectedMemory = `# Project memory\n${marker('standards', 'Fresh standards.')}custom trailing note\n`;

const planSpecBytes = '# Frozen plan\n\nIndependent frozen plan bytes.\n';
const customNoteBytes = '# Custom note\n\nIndependent note bytes.\n';

/** A standalone preload that replaces globalThis.fetch with native GitHub response shapes. */
function successfulPreload(): string {
  return `
const COMMIT = ${JSON.stringify(commit)};
const FILES = ${JSON.stringify(sourceFiles)};
const DIRECTORIES = ${JSON.stringify(sourceDirectories)};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const parsed = new URL(url);
  if (parsed.pathname === '/repos/hengboy/ai-workflow/branches/simplify') {
    return json({ name: 'simplify', commit: { sha: COMMIT } });
  }
  const prefix = '/repos/hengboy/ai-workflow/contents/';
  if (parsed.pathname.startsWith(prefix)) {
    const repoPath = decodeURIComponent(parsed.pathname.slice(prefix.length));
    const listing = DIRECTORIES[repoPath];
    if (listing) {
      return json(listing.map((name) => {
        const childPath = repoPath + '/' + name;
        return { type: childPath in DIRECTORIES ? 'dir' : 'file', name, path: childPath, sha: '0'.repeat(40), size: 10, url };
      }));
    }
    if (FILES[repoPath] !== undefined) {
      return json({ type: 'file', path: repoPath, sha: '0'.repeat(40), size: Buffer.byteLength(FILES[repoPath]), encoding: 'base64', content: Buffer.from(FILES[repoPath]).toString('base64') });
    }
  }
  return json({ message: 'Not Found' }, 404);
};
`;
}

/** A standalone preload whose branch query fails, so no source is available. */
function failingPreload(): string {
  return `
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const parsed = new URL(url);
  if (parsed.pathname === '/repos/hengboy/ai-workflow/branches/simplify') {
    return json({ message: 'rate limited' }, 403);
  }
  return json({ message: 'source unavailable' }, 503);
};
`;
}

interface CliResult { code: number; stdout: string; stderr: string }

async function runCli(cwd: string, args: string[], preload: string): Promise<CliResult> {
  try {
    const { stdout, stderr } = await exec(
      process.execPath,
      ['--import', tsxLoader, '--import', pathToFileURL(preload).href, cliEntry, ...args],
      { cwd, maxBuffer: 10 * 1024 * 1024 },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failure.code === 'number' ? failure.code : 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

async function writePreload(name: string, source: string): Promise<string> {
  const directory = await temporary('ai-workflow-sync-cli-fixture-');
  roots.push(directory);
  const path = join(directory, name);
  await writeFile(path, source);
  return path;
}

async function adoptedProject(): Promise<string> {
  const root = await temporary('ai-workflow-sync-cli-');
  roots.push(root);
  await mkdir(join(root, '.ai-workflow/index'), { recursive: true });
  await mkdir(join(root, '.ai-workflow/plans/20260101-custom'), { recursive: true });
  await mkdir(join(root, '.ai-workflow/notes/implemented/feature'), { recursive: true });
  await mkdir(join(root, '.ai-workflow/notes/archived'), { recursive: true });
  await writeFile(join(root, '.ai-workflow/AGENTS.md'), targetAgents);
  await writeFile(join(root, 'MEMORY.md'), targetMemory);
  await writeFile(join(root, '.ai-workflow/index/navigation.json'), navigationJson);
  await writeFile(join(root, '.ai-workflow/index/navigation.md'), '# Navigation\n\nAdopted navigation.\n');
  await writeFile(join(root, '.ai-workflow/notes/AGENTS.md'), notesGovernance);
  await writeFile(join(root, '.ai-workflow/notes/README.md'), notesReadme);
  await writeFile(join(root, '.ai-workflow/notes/implemented/AGENTS.md'), implementedGovernance);
  await writeFile(join(root, '.ai-workflow/notes/archived/AGENTS.md'), archivedGovernance);
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
  it('maps check, apply, repeat and structural conflict to JSON reports and exit severity from a nested cwd', async () => {
    const project = await adoptedProject();
    const preload = await writePreload('success.mjs', successfulPreload());
    const nested = join(project, 'src/deep');
    await mkdir(nested, { recursive: true });
    const before = await snapshotTree(project);

    // Check from a nested cwd with the project omitted resolves the adopted root and proposes without writing.
    const check = await runCli(nested, ['sync', '--check'], preload);
    expect(check.code).toBe(1);
    const pending = reportOf(check);
    expect(pending.status).toBe('pending');
    expect(pending.verified).toBe(false);
    expect(pending.proceed).toBe(false);
    expect(pending.check).toBe(true);
    expect(await realpath(pending.project)).toBe(await realpath(project));
    expect(pending.source).toEqual({ repository: 'hengboy/ai-workflow', branch: 'simplify', commit });
    expect([...pending.updated].sort()).toEqual(['.ai-workflow/AGENTS.md', 'MEMORY.md']);
    expect(changedPaths(before, await snapshotTree(project)), 'check mode must write nothing').toEqual([]);

    // Apply lands the safe changes and keeps independently owned data (AC-009).
    const apply = await runCli(nested, ['sync'], preload);
    expect(apply.code).toBe(0);
    const applied = reportOf(apply);
    expect(applied.status).toBe('synchronized');
    expect(applied.verified).toBe(true);
    expect(applied.proceed).toBe(true);
    expect(applied.check).toBe(false);
    expect(applied.source.commit).toBe(commit);
    expect([...applied.updated].sort()).toEqual(['.ai-workflow/AGENTS.md', 'MEMORY.md']);
    expect(await readFile(join(project, '.ai-workflow/AGENTS.md'), 'utf8')).toBe(expectedAgents);
    expect(await readFile(join(project, 'MEMORY.md'), 'utf8')).toBe(expectedMemory);
    expect(await readFile(join(project, '.ai-workflow/plans/20260101-custom/spec.md'), 'utf8')).toBe(planSpecBytes);
    expect(await readFile(join(project, '.ai-workflow/notes/implemented/feature/2026-01-01-custom.md'), 'utf8')).toBe(customNoteBytes);

    // Repeating the same immutable source is idempotent.
    const repeat = await runCli(nested, ['sync'], preload);
    expect(repeat.code).toBe(0);
    const repeated = reportOf(repeat);
    expect(repeated.status).toBe('synchronized');
    expect(repeated.updated).toEqual([]);
    expect(repeated.created).toEqual([]);

    // A malformed ownership boundary blocks with a conflict and no further writes.
    await writeFile(join(project, '.ai-workflow/AGENTS.md'), `${marker('shared-context', 'one')}${marker('shared-context', 'two')}`);
    const malformedBefore = await snapshotTree(project);
    const conflict = await runCli(nested, ['sync'], preload);
    expect(conflict.code).toBe(1);
    const blocked = reportOf(conflict);
    expect(blocked.status).toBe('conflict');
    expect(blocked.verified).toBe(false);
    expect(blocked.proceed).toBe(false);
    expect(blocked.conflicts.length).toBeGreaterThan(0);
    expect(blocked.conflicts.some((entry) => entry.path === '.ai-workflow/AGENTS.md')).toBe(true);
    expect(changedPaths(malformedBefore, await snapshotTree(project)), 'a conflict must write nothing').toEqual([]);
  });

  it('reports source failure as unverified exit 2 with zero target changes', async () => {
    const project = await adoptedProject();
    const preload = await writePreload('failure.mjs', failingPreload());
    const before = await snapshotTree(project);

    const result = await runCli(project, ['sync'], preload);
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

  it('reports a prerequisite conflict without initializing a partial adoption and keeps update unavailable', async () => {
    const project = await temporary('ai-workflow-sync-cli-partial-');
    roots.push(project);
    await mkdir(join(project, '.ai-workflow'), { recursive: true });
    const preload = await writePreload('success.mjs', successfulPreload());

    const result = await runCli(project, ['sync'], preload);
    expect(result.code).toBe(1);
    const report = reportOf(result);
    expect(report.status).toBe('conflict');
    expect(report.conflicts.length).toBeGreaterThan(0);
    // No initialization: the missing prerequisite artifacts stay missing.
    expect(await exists(join(project, 'MEMORY.md'))).toBe(false);
    expect(await exists(join(project, '.ai-workflow/index/navigation.json'))).toBe(false);
    expect(await exists(join(project, '.ai-workflow/index/navigation.md'))).toBe(false);

    const removed = await runCli(project, ['update', project], preload);
    expect(removed.code).not.toBe(0);
    expect(`${removed.stderr}${removed.stdout}`).toMatch(/unknown command/i);
  });
});
