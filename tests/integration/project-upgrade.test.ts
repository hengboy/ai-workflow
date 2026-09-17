import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { upgradeProject } from '../../src/install/index.js';
import { exists } from '../../src/utils/fs.js';
import { notePair, temporary } from '../helpers.js';

// A mutable hook reuses the repository's existing injectable atomic-write pattern
// (tests/integration/navigation-init.test.ts) to simulate one ordinary filesystem failure.
// It affects only this test process and adds no production test backdoor.
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

// The contract/notes management files an existing pre-notes project is missing.
const managementFiles = [
  '.ai-workflow/AGENTS.md',
  '.ai-workflow/notes/AGENTS.md',
  '.ai-workflow/notes/README.md',
  '.ai-workflow/notes/implemented/AGENTS.md',
  '.ai-workflow/notes/archived/AGENTS.md',
  '.ai-workflow/notes/archived/manifest.json',
] as const;

const existingProposalPath = '.ai-workflow/notes/proposed/feature/2026-08-01-existing-proposal.md';
const existingPlanPath = '.ai-workflow/plans/20260901-existing/spec.md';
const preservedPaths = [
  'MEMORY.md',
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
type UpgradeResult = { created: string[]; skipped: string[] };

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

async function upgrade(project: string): Promise<UpgradeResult> {
  const result = await runCli(['init', project, '--upgrade']);
  expect(result.code, `init --upgrade failed (exit ${result.code}): ${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as UpgradeResult;
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

describe('project upgrade', () => {
  it('AC-013 fills the missing contract and notes management structure on the first upgrade without touching existing bytes', async () => {
    const root = await temporary('ai-workflow-upgrade-first-');
    await writeExistingProject(root);
    const before = await snapshot(root, preservedPaths);

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

    for (const path of preservedPaths) expect(created).not.toContain(path);
    expect(created.filter((entry) => skipped.includes(entry))).toEqual([]);

    await expectUnchanged(root, before);
  });

  it('AC-013 reports created as empty and lists the skipped management targets on a repeat upgrade', async () => {
    const root = await temporary('ai-workflow-upgrade-repeat-');
    await writeExistingProject(root);
    await upgrade(root);
    const afterFirst = await snapshot(root, preservedPaths);

    const second = await upgrade(root);
    const created = normalized(second.created);
    const skipped = normalized(second.skipped);

    expect(created).toEqual([]);
    expect(skipped).toEqual(expect.arrayContaining([...managementFiles]));

    await expectUnchanged(root, afterFirst);
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

    // The upgrade must proceed: text that forbids ADRs or describes preserved history is not a
    // rule that still requires them. Only an imperative rule to create/read ADRs blocks writing.
    const result = await upgrade(root);

    expect(normalized(result.created)).toEqual(expect.arrayContaining([...managementFiles]));
    expect(await readFile(join(root, 'MEMORY.md'), 'utf8')).toBe(memory);
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
    const output = `${result.stderr}${result.stdout}`;

    expect(result.code).not.toBe(0);
    expect(output).toMatch(/prerequisites are missing/i);
    expect(output).toMatch(/(^|\n)\.ai-workflow(\n|$)/);
    expect(output).toContain('.ai-workflow/index/navigation.json');
    expect(output).toContain('.ai-workflow/index/navigation.md');
    expect(output).toMatch(/no files written/i);
    await expectTreeUnchanged(root, before);
  });

  it('AC-014 fails before writing when MEMORY.md is missing', async () => {
    const root = await temporary('ai-workflow-upgrade-missing-memory-');
    await writeExistingProject(root);
    await rm(join(root, 'MEMORY.md'), { force: true });
    const before = await snapshotTree(root);

    const result = await runCli(['init', root, '--upgrade']);
    const output = `${result.stderr}${result.stdout}`;

    expect(result.code).not.toBe(0);
    expect(output).toMatch(/prerequisites are missing/i);
    expect(output).toMatch(/(^|\n)MEMORY\.md(\n|$)/);
    expect(output).toMatch(/no files written/i);
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
      const output = `${result.stderr}${result.stdout}`;

      expect(result.code).not.toBe(0);
      expect(output).toMatch(/prerequisites are missing/i);
      expect(output).toContain(missing);
      expect(output).toMatch(/no files written/i);
      await expectTreeUnchanged(root, before);
    },
  );

  it('AC-014 reports every conflicting management file with its suggested content before any write', async () => {
    const root = await temporary('ai-workflow-upgrade-conflict-');
    await writeExistingProject(root);
    const contractBytes = '# Custom contract\n\nHand-written project guidance.\n';
    const readmeBytes = '# Custom notes governance\n\nHand-written rules.\n';
    await writeFile(join(root, '.ai-workflow/AGENTS.md'), contractBytes);
    await writeFile(join(root, '.ai-workflow/notes/README.md'), readmeBytes);
    const before = await snapshotTree(root);

    const result = await runCli(['init', root, '--upgrade']);
    const output = `${result.stderr}${result.stdout}`;

    expect(result.code).not.toBe(0);
    expect(output).toMatch(/conflicts; no files written/i);
    expect(output).toContain('.ai-workflow/AGENTS.md');
    expect(output).toContain('.ai-workflow/notes/README.md');
    expect(output).toContain('--- template content ---');
    const suggestedContract = await readFile(new URL('../../templates/project/AGENTS.md', import.meta.url), 'utf8');
    const suggestedReadme = await readFile(new URL('../../templates/project/notes/README.md', import.meta.url), 'utf8');
    expect(output).toContain(suggestedContract);
    expect(output).toContain(suggestedReadme);

    await expectTreeUnchanged(root, before);
    expect(await readFile(join(root, '.ai-workflow/AGENTS.md'), 'utf8')).toBe(contractBytes);
    expect(await readFile(join(root, '.ai-workflow/notes/README.md'), 'utf8')).toBe(readmeBytes);
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
    await expect(upgradeProject(root)).rejects.toThrow(/injected write failure/);

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
    await expect(upgradeProject(root)).rejects.toThrow(/injected write failure/);

    await expectTreeUnchanged(root, before);
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('.ai-workflow/\n*.log\nMEMORY.md\n');
    expect(await readFile(historyPath, 'utf8')).toBe(historyBytes);
    expect(await exists(join(root, '.ai-workflow/AGENTS.md'))).toBe(false);
  });
});
