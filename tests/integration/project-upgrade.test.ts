import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { exists } from '../../src/utils/fs.js';
import { temporary } from '../helpers.js';

const exec = promisify(execFile);

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
    await writeFile(join(root, archivedNotePath), archivedNote);
    const manifest = `${JSON.stringify({
      version: 1,
      files: { [archivedNoteKey]: `sha256:${createHash('sha256').update(archivedNote).digest('hex')}` },
    }, null, 2)}\n`;
    await writeFile(join(root, '.ai-workflow/notes/archived/manifest.json'), manifest);

    const result = await upgrade(root);

    expect(normalized(result.created)).not.toContain('.ai-workflow/notes/archived/manifest.json');
    expect(await readFile(join(root, '.ai-workflow/notes/archived/manifest.json'), 'utf8')).toBe(manifest);
    expect(await readFile(join(root, archivedNotePath), 'utf8')).toBe(archivedNote);

    const validated = await runCli(['notes', 'validate', '--project', root]);
    expect(validated.code).toBe(0);
    expect(JSON.parse(validated.stdout)).toEqual({ valid: true, errors: [] });
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
