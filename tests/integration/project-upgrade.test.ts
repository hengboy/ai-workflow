import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { upgradeProject } from '../../src/install/index.js';
import { exists } from '../../src/utils/fs.js';
import { notePair, temporary } from '../helpers.js';

// A mutable hook reuses the repository's existing injectable atomic-write pattern to simulate one
// ordinary filesystem failure. It affects only this test process and adds no production backdoor.
const fsControl = vi.hoisted(() => ({ failPath: null as string | null, after: false }));

vi.mock('../../src/utils/fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/fs.js')>();
  return {
    ...actual,
    atomicWrite: async (path: string, contents: string | Buffer): Promise<void> => {
      if (fsControl.failPath !== null && path.endsWith(fsControl.failPath)) {
        if (fsControl.after) await actual.atomicWrite(path, contents);
        throw new Error(`injected write failure: ${path}`);
      }
      await actual.atomicWrite(path, contents);
    },
  };
});

const exec = promisify(execFile);

afterEach(() => {
  fsControl.failPath = null;
  fsControl.after = false;
});

const lifecycleDirectories = ['proposed', 'implemented', 'rejected', 'archived'] as const;
const noteClasses = ['architecture', 'bug-fix', 'feature', 'process', 'simplification', 'testing'] as const;

// The five generated governance documents plus the empty archive data bootstrap that an
// existing pre-notes project is missing.
const generatedFiles = [
  '.ai-workflow/AGENTS.md',
  '.ai-workflow/notes/AGENTS.md',
  '.ai-workflow/notes/README.md',
  '.ai-workflow/notes/implemented/AGENTS.md',
  '.ai-workflow/notes/archived/AGENTS.md',
] as const;
const managementFiles = [
  ...generatedFiles,
  '.ai-workflow/notes/archived/manifest.json',
] as const;

const existingProposalPath = '.ai-workflow/notes/proposed/feature/2026-08-01-existing-proposal.md';
const existingPlanPath = '.ai-workflow/plans/20260901-existing/spec.md';
const preservedPaths = [
  '.ai-workflow/index/navigation.json',
  '.ai-workflow/index/navigation.md',
  existingPlanPath,
  existingProposalPath,
] as const;

const memoryBytes = '# Project memory\n\nExisting standard that must survive an upgrade.\n';
const planBytes = '---\nplan_id: "20260901-existing"\nstatus: frozen\n---\n\n# Existing frozen plan\n';
const navigationMarkdown = '# Navigation\n\nHand-written navigation bytes preserved across upgrade.\n';
const navigationJson = `${JSON.stringify({
  version: 1,
  module_roots: [{ id: 'src', path: 'src', owner_role: 'shared', responsibility: 'existing module', language: 'typescript', entry_kinds: ['exported-symbol'] }],
  features: [{
    id: 'src', name: 'src', aliases: [], module_root: 'src', entries: ['src/index.ts'], symbols: [], related_files: [],
    tests: [], depends_on: [], relations: [], owner_role: 'shared', responsibility: 'existing module',
    read_scope: ['src/index.ts'], shared_entry: false,
  }],
}, null, 2)}\n`;

const existingProposal = `# Agent Note: existing-proposal

Status: proposed

## Problem

An existing proposal must survive the upgrade byte for byte.

## Proposal

Keep the existing note untouched.

## Alternatives considered

- Rewriting the note was declined because it is user data.

## Acceptance criteria

- The note bytes are unchanged after upgrade.

## Risks

- A rewrite would lose the original rationale.
`;

const archivedNote = `# Agent Note: existing-decision

Status: implemented
Archived: 2026-05-01

## Problem

A delivered decision stopped guiding future work.

## Decision

Keep the delivered record as frozen history.

## Alternatives considered

- Deleting the record was declined to preserve the rationale.

## Consequences

- The sealed bytes are registered in the archive manifest.
`;

type CliResult = { code: number; stdout: string; stderr: string };
type UpgradeReport = {
  project: string;
  source: { repository: string; branch: string; commit: string | null };
  status: string;
  verified: boolean;
  proceed: boolean;
  check: boolean;
  created: string[];
  updated: string[];
  skipped: string[];
  warnings: Array<{ reason: string; path?: string; section?: string }>;
  conflicts: Array<{ reason: string; path?: string; line?: number; originalLine?: string }>;
};

const localSnapshotWarningReason = 'Local shipped templates were used; the current upstream snapshot has not been verified';

async function runCli(args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

/**
 * Run the supported `init --upgrade` local path and enforce the local-only report contract:
 * exit 2, `needs_attention`, unverified, safe continuation, and the exact local-snapshot warning.
 */
async function upgrade(project: string): Promise<UpgradeReport> {
  const result = await runCli(['init', project, '--upgrade']);
  expect(result.code, `init --upgrade exit ${result.code}: ${result.stderr}`).toBe(2);
  const report = JSON.parse(result.stdout) as UpgradeReport;
  expect(report.status).toBe('needs_attention');
  expect(report.verified).toBe(false);
  expect(report.proceed).toBe(true);
  expect(report.source.commit).toBeNull();
  expect(report.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ reason: localSnapshotWarningReason })]));
  return report;
}

function normalized(entries: readonly string[]): string[] {
  return entries.map((entry) => entry.replace(/^\.\//, '').replace(/\/$/, ''));
}

async function writeExistingProject(root: string): Promise<void> {
  await mkdir(join(root, '.ai-workflow/index'), { recursive: true });
  await mkdir(join(root, '.ai-workflow/plans/20260901-existing'), { recursive: true });
  await mkdir(join(root, '.ai-workflow/notes/proposed/feature'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'MEMORY.md'), memoryBytes);
  await writeFile(join(root, 'src/index.ts'), 'export const existing = true;\n');
  await writeFile(join(root, '.ai-workflow/index/navigation.json'), navigationJson);
  await writeFile(join(root, '.ai-workflow/index/navigation.md'), navigationMarkdown);
  await writeFile(join(root, existingPlanPath), planBytes);
  await writeFile(join(root, existingProposalPath), existingProposal);
  await writeFile(join(root, '.gitignore'), '.ai-workflow/\n*.log\nMEMORY.md\n');
}

async function snapshot(root: string, paths: readonly string[]): Promise<Map<string, string>> {
  const captured = new Map<string, string>();
  for (const path of paths) captured.set(path, (await readFile(join(root, path))).toString('base64'));
  return captured;
}

async function expectUnchanged(root: string, before: Map<string, string>): Promise<void> {
  for (const [path, contents] of before) {
    expect((await readFile(join(root, path))).toString('base64'), `${path} must keep its original bytes`).toBe(contents);
  }
}

// Whole-tree snapshot: records every file under the project root so a failure path can be
// proven to neither add nor remove entries, independently of any expected-created list.
async function snapshotTree(root: string): Promise<Map<string, string>> {
  const captured = new Map<string, string>();
  async function walk(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute, relative);
      else captured.set(relative, (await readFile(absolute)).toString('base64'));
    }
  }
  await walk(root, '');
  return captured;
}

async function expectTreeUnchanged(root: string, before: Map<string, string>): Promise<void> {
  const after = await snapshotTree(root);
  expect([...after.keys()].sort(), 'the project tree must neither gain nor lose entries').toEqual([...before.keys()].sort());
  for (const [path, contents] of before) {
    expect(after.get(path), `${path} must keep its original bytes`).toBe(contents);
  }
}

const shippedTemplate = (name: string): Promise<string> => readFile(new URL(`../../templates/project/${name}`, import.meta.url), 'utf8');

describe('project upgrade generated replacement and completion', () => {
  it('AC-009 completes missing generated governance and management structure while preserving local bytes', async () => {
    const root = await temporary('ai-workflow-upgrade-first-');
    await writeExistingProject(root);
    const before = await snapshot(root, preservedPaths);
    const memoryBefore = await readFile(join(root, 'MEMORY.md'));

    const result = await upgrade(root);
    const created = normalized(result.created);
    const skipped = normalized(result.skipped);

    expect(created).toEqual(expect.arrayContaining([...managementFiles]));
    for (const path of managementFiles) expect(await exists(join(root, path))).toBe(true);

    const categoryDirectories = lifecycleDirectories.flatMap((lifecycle) =>
      noteClasses.map((noteClass) => `.ai-workflow/notes/${lifecycle}/${noteClass}`),
    );
    expect(categoryDirectories).toHaveLength(24);
    for (const path of categoryDirectories) expect(await exists(join(root, path))).toBe(true);

    // The generated documents are the complete markerless shipped templates.
    for (const name of ['AGENTS.md', 'notes/AGENTS.md', 'notes/README.md', 'notes/implemented/AGENTS.md', 'notes/archived/AGENTS.md']) {
      const local = name === 'AGENTS.md' ? '.ai-workflow/AGENTS.md' : `.ai-workflow/${name}`;
      const shipped = await shippedTemplate(name);
      expect(await readFile(join(root, local), 'utf8')).toBe(shipped);
      expect(shipped).not.toMatch(/ai-workflow:section/);
    }

    for (const path of preservedPaths) expect(created).not.toContain(path);
    expect(created.filter((entry) => skipped.includes(entry))).toEqual([]);

    // MEMORY is local project content, not a managed target: its bytes stay identical.
    expect(result.created).not.toContain('MEMORY.md');
    expect(result.updated).not.toContain('MEMORY.md');
    expect(await readFile(join(root, 'MEMORY.md'))).toEqual(memoryBefore);

    await expectUnchanged(root, before);
  });

  it('AC-009 reports created as empty and lists the skipped generated targets on a repeat upgrade', async () => {
    const root = await temporary('ai-workflow-upgrade-repeat-');
    await writeExistingProject(root);
    await upgrade(root);
    const afterFirst = await snapshot(root, preservedPaths);

    const second = await upgrade(root);
    const created = normalized(second.created);
    const skipped = normalized(second.skipped);

    expect(created).toEqual([]);
    expect(skipped).toEqual(expect.arrayContaining([...generatedFiles]));

    await expectUnchanged(root, afterFirst);
  });

  it('AC-009 fully replaces stale markerless generated bytes and preserves local MEMORY with CRLF', async () => {
    const root = await temporary('ai-workflow-upgrade-replace-');
    await writeExistingProject(root);
    const crlfMemory = '# Project memory\r\n\r\nCRLF standard that must survive an upgrade.\r\n';
    await writeFile(join(root, 'MEMORY.md'), crlfMemory);
    await writeFile(join(root, '.ai-workflow/AGENTS.md'), '# Project contract\n\nStale manually edited body.\n');
    await writeFile(join(root, '.ai-workflow/notes/AGENTS.md'), '# Agent Notes instructions\n\nStale notes body.\n');
    const navigationBefore = await readFile(join(root, '.ai-workflow/index/navigation.json'), 'utf8');

    const report = await upgrade(root);

    expect(normalized(report.updated)).toEqual(expect.arrayContaining(['.ai-workflow/AGENTS.md', '.ai-workflow/notes/AGENTS.md']));
    expect(await readFile(join(root, '.ai-workflow/AGENTS.md'), 'utf8')).toBe(await shippedTemplate('AGENTS.md'));
    expect(await readFile(join(root, '.ai-workflow/notes/AGENTS.md'), 'utf8')).toBe(await shippedTemplate('notes/AGENTS.md'));
    expect(await readFile(join(root, 'MEMORY.md'), 'utf8')).toBe(crlfMemory);
    expect(await readFile(join(root, '.ai-workflow/index/navigation.json'), 'utf8')).toBe(navigationBefore);
  });

  it('migrates legacy whole-tree .ai-workflow and MEMORY.md ignore entries on upgrade', async () => {
    const root = await temporary('ai-workflow-upgrade-ignore-legacy-');
    await writeExistingProject(root);

    await upgrade(root);

    const lines = (await readFile(join(root, '.gitignore'), 'utf8')).split(/\r?\n/).map((line) => line.trim());
    expect(lines).not.toContain('.ai-workflow');
    expect(lines).not.toContain('.ai-workflow/');
    expect(lines).not.toContain('MEMORY.md');
    expect(lines).toContain('.ai-workflow/plans/');
    expect(lines).toContain('.worktrees/');
    expect(lines).toContain('*.log');
  });

  it('REQ-007 keeps an existing non-empty valid archive manifest instead of overwriting it with the empty template', async () => {
    const root = await temporary('ai-workflow-upgrade-manifest-');
    const archivedNotePath = '.ai-workflow/notes/archived/architecture/2026-04-01-existing-decision.md';
    const archivedNoteKey = 'archived/architecture/2026-04-01-existing-decision.md';
    await mkdir(join(root, '.ai-workflow/index'), { recursive: true });
    await mkdir(join(root, '.ai-workflow/notes/archived/architecture'), { recursive: true });
    await writeFile(join(root, 'MEMORY.md'), memoryBytes);
    await writeFile(join(root, '.ai-workflow/index/navigation.json'), navigationJson);
    await writeFile(join(root, '.ai-workflow/index/navigation.md'), navigationMarkdown);
    await writeFile(join(root, '.gitignore'), '.ai-workflow/\n*.log\nMEMORY.md\n');
    const files = notePair(archivedNotePath, archivedNote);
    const zhKey = archivedNoteKey.replace(/\.md$/, '.zh.md');
    const metaKey = archivedNoteKey.replace(/\.md$/, '.i18n.yaml');
    await writeFile(join(root, archivedNotePath), files.english);
    await writeFile(join(root, archivedNotePath.replace(/\.md$/, '.zh.md')), files.chinese);
    await writeFile(join(root, archivedNotePath.replace(/\.md$/, '.i18n.yaml')), files.meta);
    const manifest = `${JSON.stringify({
      version: 1,
      files: {
        [archivedNoteKey]: `sha256:${createHash('sha256').update(files.english).digest('hex')}`,
        [zhKey]: `sha256:${createHash('sha256').update(files.chinese).digest('hex')}`,
        [metaKey]: `sha256:${createHash('sha256').update(files.meta).digest('hex')}`,
      },
    }, null, 2)}\n`;
    await writeFile(join(root, '.ai-workflow/notes/archived/manifest.json'), manifest);

    const result = await upgrade(root);

    expect(normalized(result.created)).not.toContain('.ai-workflow/notes/archived/manifest.json');
    expect(await readFile(join(root, '.ai-workflow/notes/archived/manifest.json'), 'utf8')).toBe(manifest);
    expect(await readFile(join(root, archivedNotePath), 'utf8')).toBe(files.english);

    const validated = await runCli(['notes', 'validate', '--project', root]);
    expect(validated.code).toBe(0);
    expect(JSON.parse(validated.stdout)).toEqual({ valid: true, errors: [] });
  });

  it.each([
    'Do not create ADRs; decisions are recorded as notes.',
    'Existing ADR history files are preserved but never read.',
  ])('REQ-007 treats descriptive or negated ADR text as a guideline, not a retired instruction: %s', async (line) => {
    const root = await temporary('ai-workflow-upgrade-adr-descriptive-');
    await writeExistingProject(root);
    const memory = `# Project memory\n\n## Standards\n\n- ${line}\n`;
    await writeFile(join(root, 'MEMORY.md'), memory);

    const result = await upgrade(root);

    expect(normalized(result.created)).toEqual(expect.arrayContaining([...managementFiles]));
    expect(await readFile(join(root, 'MEMORY.md'), 'utf8')).toContain(line);
  });

  it('REQ-007 keeps the removed update command unavailable', async () => {
    const root = await temporary('ai-workflow-upgrade-update-');
    await writeExistingProject(root);

    const result = await runCli(['update', root]);
    const output = `${result.stderr}${result.stdout}`;

    expect(result.code).not.toBe(0);
    expect(output).toMatch(/unknown command/i);
    expect(output).toMatch(/update/i);
  });
});

describe('project upgrade failure boundaries', () => {
  it('AC-014 fails before writing when .ai-workflow is missing', async () => {
    const root = await temporary('ai-workflow-upgrade-missing-tree-');
    await writeFile(join(root, 'MEMORY.md'), memoryBytes);
    await writeFile(join(root, '.gitignore'), 'dist/\n');
    const before = await snapshotTree(root);

    const result = await runCli(['init', root, '--upgrade']);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as UpgradeReport;
    expect(report.status).toBe('conflict');
    expect(report.verified).toBe(false);
    expect(report.proceed).toBe(false);
    expect(report.created).toEqual([]);
    expect(report.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.ai-workflow' }),
      expect.objectContaining({ path: '.ai-workflow/index/navigation.json' }),
      expect.objectContaining({ path: '.ai-workflow/index/navigation.md' }),
    ]));
    await expectTreeUnchanged(root, before);
  });

  it('AC-014 fails before writing when MEMORY.md is missing', async () => {
    const root = await temporary('ai-workflow-upgrade-missing-memory-');
    await writeExistingProject(root);
    await rm(join(root, 'MEMORY.md'), { force: true });
    const before = await snapshotTree(root);

    const result = await runCli(['init', root, '--upgrade']);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as UpgradeReport;
    expect(report.status).toBe('conflict');
    expect(report.proceed).toBe(false);
    expect(report.created).toEqual([]);
    expect(report.conflicts.some((entry) => entry.path === 'MEMORY.md')).toBe(true);
    await expectTreeUnchanged(root, before);
  });

  it.each(['.ai-workflow/index/navigation.json', '.ai-workflow/index/navigation.md'])(
    'AC-014 fails before writing when %s is missing',
    async (missing) => {
      const root = await temporary('ai-workflow-upgrade-missing-navigation-');
      await writeExistingProject(root);
      await rm(join(root, missing), { force: true });
      const before = await snapshotTree(root);

      const result = await runCli(['init', root, '--upgrade']);
      expect(result.code).toBe(1);
      const report = JSON.parse(result.stdout) as UpgradeReport;
      expect(report.status).toBe('conflict');
      expect(report.proceed).toBe(false);
      expect(report.created).toEqual([]);
      expect(report.conflicts.some((entry) => entry.path === missing)).toBe(true);
      await expectTreeUnchanged(root, before);
    },
  );

  it('AC-014 replaces differing markerless generated content instead of preserving it as local', async () => {
    const root = await temporary('ai-workflow-upgrade-markerless-');
    await writeExistingProject(root);
    const contractBytes = '# Custom contract\n\nHand-written differing shared context.\n';
    await writeFile(join(root, '.ai-workflow/AGENTS.md'), contractBytes);
    const before = await snapshot(root, preservedPaths);

    const report = await upgrade(root);

    expect(report.status).toBe('needs_attention');
    expect(normalized(report.updated)).toContain('.ai-workflow/AGENTS.md');
    expect(await readFile(join(root, '.ai-workflow/AGENTS.md'), 'utf8')).toBe(await shippedTemplate('AGENTS.md'));
    expect(normalized(report.created)).toEqual(expect.arrayContaining([...managementFiles].filter((path) => path !== '.ai-workflow/AGENTS.md')));
    await expectUnchanged(root, before);
  });

  it('AC-008 refuses a generated target that still carries legacy section markers before any write', async () => {
    const root = await temporary('ai-workflow-upgrade-legacy-marker-');
    await writeExistingProject(root);
    const legacy = '# Project contract\n\n<!-- ai-workflow:section shared-context:begin -->\nold body\n<!-- ai-workflow:section shared-context:end -->\n';
    await writeFile(join(root, '.ai-workflow/AGENTS.md'), legacy);
    const before = await snapshotTree(root);

    const result = await runCli(['init', root, '--upgrade']);

    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as UpgradeReport;
    expect(report.status).toBe('conflict');
    expect(report.conflicts.some((entry) => entry.path === '.ai-workflow/AGENTS.md')).toBe(true);
    await expectTreeUnchanged(root, before);
    expect(await readFile(join(root, '.ai-workflow/AGENTS.md'), 'utf8')).toBe(legacy);
  });

  it('AC-014 stops before writing and reports the exact MEMORY.md line that still requires ADRs', async () => {
    const root = await temporary('ai-workflow-upgrade-adr-memory-');
    await writeExistingProject(root);
    const adrMemory = [
      '# Project memory',
      '',
      '## Standards',
      '',
      '- Record every architectural decision as an ADR in `.ai-workflow/adr/`.',
      '',
    ].join('\n');
    await writeFile(join(root, 'MEMORY.md'), adrMemory);
    const before = await snapshotTree(root);

    const result = await runCli(['init', root, '--upgrade']);
    const output = `${result.stderr}${result.stdout}`;

    expect(result.code).not.toBe(0);
    expect(output).toMatch(/still require ADRs/i);
    expect(output).toMatch(/merge them explicitly/i);
    expect(output).toContain('MEMORY.md:5:');
    await expectTreeUnchanged(root, before);
    expect(await readFile(join(root, 'MEMORY.md'), 'utf8')).toBe(adrMemory);
  });

  it('AC-014 stops before writing and reports the exact project contract line that still requires ADRs', async () => {
    const root = await temporary('ai-workflow-upgrade-adr-contract-');
    await writeExistingProject(root);
    const contractBytes = '# Project contract\n\n- Every non-mechanical change must create an ADR.\n';
    await writeFile(join(root, '.ai-workflow/AGENTS.md'), contractBytes);
    const before = await snapshotTree(root);

    const result = await runCli(['init', root, '--upgrade']);
    const output = `${result.stderr}${result.stdout}`;

    expect(result.code).not.toBe(0);
    expect(output).toMatch(/still require ADRs/i);
    expect(output).toContain('.ai-workflow/AGENTS.md:3:');
    await expectTreeUnchanged(root, before);
    expect(await readFile(join(root, '.ai-workflow/AGENTS.md'), 'utf8')).toBe(contractBytes);
  });

  it('AC-014 still stops before writing for an imperative rule that requires creating ADRs', async () => {
    const root = await temporary('ai-workflow-upgrade-adr-imperative-');
    await writeExistingProject(root);
    const memory = '# Project memory\n\n## Standards\n\n- Create an ADR for every architecture decision\n';
    await writeFile(join(root, 'MEMORY.md'), memory);
    const before = await snapshotTree(root);

    const result = await runCli(['init', root, '--upgrade']);
    const output = `${result.stderr}${result.stdout}`;

    expect(result.code).not.toBe(0);
    expect(output).toMatch(/still require ADRs/i);
    expect(output).toMatch(/merge them explicitly/i);
    await expectTreeUnchanged(root, before);
    expect(await readFile(join(root, 'MEMORY.md'), 'utf8')).toBe(memory);
  });

  it('AC-014 never scans ADR history files when checking for retired ADR instructions', async () => {
    const root = await temporary('ai-workflow-upgrade-adr-history-');
    await writeExistingProject(root);
    const historyPath = join(root, '.ai-workflow/adr/0001-history.md');
    const historyBytes = '# ADR-0001: Legacy decision\n\nStatus: accepted\n\n- Agents must create an ADR for every change.\n';
    await mkdir(join(root, '.ai-workflow/adr'), { recursive: true });
    await writeFile(historyPath, historyBytes);

    const result = await upgrade(root);

    expect(normalized(result.created)).toEqual(expect.arrayContaining([...managementFiles]));
    expect(normalized(result.created)).not.toContain('.ai-workflow/adr/0001-history.md');
    expect(await readFile(historyPath, 'utf8')).toBe(historyBytes);
  });

  it('AC-013 completes the upgrade on a retry after the ADR rule was merged out by hand', async () => {
    const root = await temporary('ai-workflow-upgrade-adr-retry-');
    await writeExistingProject(root);
    await writeFile(join(root, 'MEMORY.md'), '# Project memory\n\n- Use the ADR workflow.\n');

    const failed = await runCli(['init', root, '--upgrade']);
    expect(failed.code).not.toBe(0);

    await writeFile(join(root, 'MEMORY.md'), '# Project memory\n\nDecisions are recorded as agent notes.\n');
    const before = await snapshot(root, preservedPaths);
    const result = await upgrade(root);

    expect(normalized(result.created)).toEqual(expect.arrayContaining([...managementFiles]));
    await expectUnchanged(root, before);
  });

  it('AC-014 reclaims this upgrade\'s files and empty directories and restores .gitignore after a write failure', async () => {
    const root = await temporary('ai-workflow-upgrade-recovery-');
    await writeExistingProject(root);
    await writeFile(join(root, '.gitignore'), 'dist/\n');
    const historyPath = join(root, '.ai-workflow/adr/0001-history.md');
    const historyBytes = '# ADR-0001: Legacy decision\n\nStatus: accepted\n\nHistorical user data.\n';
    await mkdir(join(root, '.ai-workflow/adr'), { recursive: true });
    await writeFile(historyPath, historyBytes);
    const before = await snapshotTree(root);

    // Fail after the .gitignore write commits, so recovery must undo both the managed files
    // written earlier in this call and the .gitignore bytes it replaced.
    fsControl.failPath = '.gitignore';
    fsControl.after = true;
    const report = await upgradeProject(root);
    expect(report.status).toBe('failed');
    expect(report.verified).toBe(false);
    expect(report.proceed).toBe(false);
    expect(report.warnings.some((warning) => /injected write failure/.test(warning.reason))).toBe(true);

    await expectTreeUnchanged(root, before);
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('dist/\n');
    expect(await readFile(historyPath, 'utf8')).toBe(historyBytes);
    expect(await exists(join(root, '.ai-workflow/AGENTS.md'))).toBe(false);
    expect(await exists(join(root, '.ai-workflow/notes/README.md'))).toBe(false);
    expect(await exists(join(root, '.ai-workflow/notes/implemented'))).toBe(false);
    expect(await exists(join(root, '.ai-workflow/notes/archived'))).toBe(false);
  });

  it('AC-014 reclaims a management file whose atomic write committed at rename and then failed', async () => {
    const root = await temporary('ai-workflow-upgrade-atomic-after-');
    await writeExistingProject(root);
    const historyPath = join(root, '.ai-workflow/adr/0001-history.md');
    const historyBytes = '# ADR-0001: Legacy decision\n\nStatus: accepted\n\nHistorical user data.\n';
    await mkdir(join(root, '.ai-workflow/adr'), { recursive: true });
    await writeFile(historyPath, historyBytes);
    const before = await snapshotTree(root);

    // Fail after the rename of the first management file commits, so the file exists on disk even
    // though atomicWrite never returned and the upgrade never registered it for cleanup.
    fsControl.failPath = '.ai-workflow/AGENTS.md';
    fsControl.after = true;
    const report = await upgradeProject(root);
    expect(report.status).toBe('failed');
    expect(report.verified).toBe(false);
    expect(report.proceed).toBe(false);
    expect(report.warnings.some((warning) => /injected write failure/.test(warning.reason))).toBe(true);

    await expectTreeUnchanged(root, before);
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('.ai-workflow/\n*.log\nMEMORY.md\n');
    expect(await readFile(historyPath, 'utf8')).toBe(historyBytes);
    expect(await exists(join(root, '.ai-workflow/AGENTS.md'))).toBe(false);
  });

  it('AC-010 blocks with a conflict when a supported managed path is occupied by a directory', async () => {
    const root = await temporary('ai-workflow-upgrade-eisdir-');
    await writeExistingProject(root);
    await mkdir(join(root, '.ai-workflow/AGENTS.md'), { recursive: true });
    await writeFile(join(root, '.ai-workflow/AGENTS.md/placeholder'), 'occupied\n');
    const before = await snapshotTree(root);

    const report = await upgradeProject(root);

    expect(report.status).toBe('conflict');
    expect(report.verified).toBe(false);
    expect(report.proceed).toBe(false);
    expect(report.updated).toEqual([]);
    expect(report.conflicts.some((entry) => entry.path === '.ai-workflow/AGENTS.md')).toBe(true);
    await expectTreeUnchanged(root, before);
  });
});
