import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { initializeProject } from '../../src/install/index.js';
import { temporary } from '../helpers.js';

const exec = promisify(execFile);
const cli = ['exec', 'tsx', 'src/cli.ts'] as const;
const manifestPath = '.ai-workflow/notes/archived/manifest.json';
const archivedNotePath = '.ai-workflow/notes/archived/testing/2026-04-01-historical-decision.md';
const archivedNoteKey = 'archived/testing/2026-04-01-historical-decision.md';

const archivedNote = `# Agent Note: historical-decision

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

function independentDigest(contents: string): string {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`;
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const contents: Record<string, string> = {};
  async function walk(relative: string): Promise<void> {
    const entries = (await readdir(join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) contents[path] = (await readFile(join(root, path))).toString('base64');
    }
  }
  await walk('.ai-workflow');
  return contents;
}

async function archiveCli(project: string): Promise<string> {
  return (await exec('pnpm', [...cli, 'notes', 'archive', '--project', project, '--seal'])).stdout;
}

describe('notes archive CLI', () => {
  it('AC-009 seals a moved archived note through the CLI, registers its independent sha256, and passes notes validate', async () => {
    const project = await temporary('ai-workflow-notes-seal-cli-');
    await initializeProject(project);
    await writeFile(join(project, archivedNotePath), archivedNote);

    expect(JSON.parse(await archiveCli(project))).toEqual({ sealed: [archivedNoteKey] });
    expect(JSON.parse(await readFile(join(project, manifestPath), 'utf8'))).toEqual({
      version: 1,
      files: { [archivedNoteKey]: independentDigest(archivedNote) },
    });
    expect(await readFile(join(project, archivedNotePath), 'utf8')).toBe(archivedNote);

    const validated = (await exec('pnpm', [...cli, 'notes', 'validate', '--project', project])).stdout;

    expect(JSON.parse(validated)).toEqual({ valid: true, errors: [] });
  });

  it('AC-009 leaves every byte unchanged when the CLI seals again with no new records', async () => {
    const project = await temporary('ai-workflow-notes-seal-cli-idempotent-');
    await initializeProject(project);
    await writeFile(join(project, archivedNotePath), archivedNote);
    await archiveCli(project);
    const before = await snapshot(project);

    expect(JSON.parse(await archiveCli(project))).toEqual({ sealed: [] });
    expect(await snapshot(project)).toEqual(before);
  });

  // The counterexamples below prove through the CLI that a rewritten archive
  // cannot be sealed over. They are regression guards: the behavior was
  // implemented before this test slice was added.

  const unregisteredNotePath = '.ai-workflow/notes/archived/architecture/2026-04-02-unregistered-decision.md';

  type CliResult = { code: number; stdout: string; stderr: string };

  async function runCli(project: string, args: string[]): Promise<CliResult> {
    try {
      const { stdout, stderr } = await exec('pnpm', [...cli, ...args]);
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return { code: typeof failure.code === 'number' ? failure.code : 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
    }
  }

  function archivedDecision(title: string, archived: string): string {
    return `# Agent Note: ${title}

Status: implemented
Archived: ${archived}

## Problem

A delivered decision no longer guides future work.

## Decision

Keep the delivered record as frozen history.

## Alternatives considered

- Deleting the record was declined to preserve the rationale.

## Consequences

- The sealed bytes are registered in the archive manifest.
`;
  }

  it('AC-009 fails notes validate through the CLI with a file-level reason after a sealed body is tampered', async () => {
    const project = await temporary('ai-workflow-notes-seal-cli-tamper-');
    await initializeProject(project);
    await writeFile(join(project, archivedNotePath), archivedNote);
    await archiveCli(project);
    const manifestBefore = await readFile(join(project, manifestPath), 'utf8');
    const tampered = archivedNote.replace('A delivered decision stopped guiding future work.', 'A silently rewritten problem statement.');
    await writeFile(join(project, archivedNotePath), tampered);

    const result = await runCli(project, ['notes', 'validate', '--project', project]);

    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout) as { valid: boolean; errors: string[] };
    expect(parsed.valid).toBe(false);
    expect(parsed.errors).toContain(`${archivedNoteKey}: archived note bytes differ from the manifest digest`);
    expect(await readFile(join(project, manifestPath), 'utf8')).toBe(manifestBefore);
    expect(await readFile(join(project, archivedNotePath), 'utf8')).toBe(tampered);
  });

  it('AC-009 fails notes validate through the CLI when a sealed note is deleted', async () => {
    const project = await temporary('ai-workflow-notes-seal-cli-delete-');
    await initializeProject(project);
    await writeFile(join(project, archivedNotePath), archivedNote);
    await archiveCli(project);
    const manifestBefore = await readFile(join(project, manifestPath), 'utf8');
    await rm(join(project, archivedNotePath));

    const result = await runCli(project, ['notes', 'validate', '--project', project]);

    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout) as { valid: boolean; errors: string[] };
    expect(parsed.valid).toBe(false);
    expect(parsed.errors).toContain(`${manifestPath}: entry ${archivedNoteKey} has no archived note`);
    expect(await readFile(join(project, manifestPath), 'utf8')).toBe(manifestBefore);
  });

  it('AC-009 fails notes validate through the CLI after a sealed note is moved into another class', async () => {
    const project = await temporary('ai-workflow-notes-seal-cli-move-');
    await initializeProject(project);
    await writeFile(join(project, archivedNotePath), archivedNote);
    await archiveCli(project);
    const movedPath = '.ai-workflow/notes/archived/feature/2026-04-01-historical-decision.md';
    await rename(join(project, archivedNotePath), join(project, movedPath));

    const result = await runCli(project, ['notes', 'validate', '--project', project]);

    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout) as { valid: boolean; errors: string[] };
    expect(parsed.valid).toBe(false);
    expect(parsed.errors).toContain(`${manifestPath}: entry ${archivedNoteKey} has no archived note`);
    expect(parsed.errors).toContain(`${movedPath}: archived note is not registered in ${manifestPath}`);
  });

  it('AC-009 fails notes validate through the CLI for an archived note with no manifest entry', async () => {
    const project = await temporary('ai-workflow-notes-seal-cli-extra-');
    await initializeProject(project);
    await writeFile(join(project, archivedNotePath), archivedNote);
    await archiveCli(project);
    const unregistered = archivedDecision('unregistered-decision', '2026-04-02');
    await writeFile(join(project, unregisteredNotePath), unregistered);
    const manifestBefore = await readFile(join(project, manifestPath), 'utf8');

    const result = await runCli(project, ['notes', 'validate', '--project', project]);

    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout) as { valid: boolean; errors: string[] };
    expect(parsed.valid).toBe(false);
    expect(parsed.errors).toContain(`${unregisteredNotePath}: archived note is not registered in ${manifestPath}`);
    expect(await readFile(join(project, unregisteredNotePath), 'utf8')).toBe(unregistered);
    expect(await readFile(join(project, manifestPath), 'utf8')).toBe(manifestBefore);
  });

  it('AC-009 fails notes validate through the CLI for a sealed archived note with a wrong status or archived date', async () => {
    const statusProject = await temporary('ai-workflow-notes-seal-cli-status-');
    await initializeProject(statusProject);
    await writeFile(join(statusProject, archivedNotePath), archivedNote);
    await archiveCli(statusProject);
    await writeFile(join(statusProject, archivedNotePath), archivedNote.replace('Status: implemented', 'Status: archived'));

    const statusResult = await runCli(statusProject, ['notes', 'validate', '--project', statusProject]);

    expect(statusResult.code).toBe(1);
    const statusParsed = JSON.parse(statusResult.stdout) as { valid: boolean; errors: string[] };
    expect(statusParsed.valid).toBe(false);
    expect(statusParsed.errors).toContain(`${archivedNotePath}: Status must be implemented for lifecycle archived`);

    const dateProject = await temporary('ai-workflow-notes-seal-cli-date-');
    await initializeProject(dateProject);
    await writeFile(join(dateProject, archivedNotePath), archivedNote);
    await archiveCli(dateProject);
    await writeFile(join(dateProject, archivedNotePath), archivedNote.replace('Archived: 2026-05-01', 'Archived: 2026-02-31'));

    const dateResult = await runCli(dateProject, ['notes', 'validate', '--project', dateProject]);

    expect(dateResult.code).toBe(1);
    const dateParsed = JSON.parse(dateResult.stdout) as { valid: boolean; errors: string[] };
    expect(dateParsed.valid).toBe(false);
    expect(dateParsed.errors).toContain(`${archivedNotePath}: Archived must immediately follow Status with a real YYYY-MM-DD date`);
  });

  it('AC-009 refuses to seal a changed old note through the CLI and leaves the manifest and both files byte-identical', async () => {
    const project = await temporary('ai-workflow-notes-seal-cli-refuse-');
    await initializeProject(project);
    await writeFile(join(project, archivedNotePath), archivedNote);
    await archiveCli(project);
    const manifestBefore = await readFile(join(project, manifestPath), 'utf8');
    const tampered = archivedNote.replace('A delivered decision stopped guiding future work.', 'A silently rewritten problem statement.');
    await writeFile(join(project, archivedNotePath), tampered);
    const unregistered = archivedDecision('unregistered-decision', '2026-04-02');
    await writeFile(join(project, unregisteredNotePath), unregistered);

    const result = await runCli(project, ['notes', 'archive', '--project', project, '--seal']);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('sealed archived note bytes changed');
    expect(result.stderr).toContain(archivedNoteKey);
    expect(await readFile(join(project, manifestPath), 'utf8')).toBe(manifestBefore);
    expect(await readFile(join(project, archivedNotePath), 'utf8')).toBe(tampered);
    expect(await readFile(join(project, unregisteredNotePath), 'utf8')).toBe(unregistered);

    const validated = await runCli(project, ['notes', 'validate', '--project', project]);

    expect(validated.code).toBe(1);
    const parsed = JSON.parse(validated.stdout) as { valid: boolean; errors: string[] };
    expect(parsed.valid).toBe(false);
    expect(parsed.errors).toContain(`${archivedNoteKey}: archived note bytes differ from the manifest digest`);
    expect(parsed.errors).toContain(`${unregisteredNotePath}: archived note is not registered in ${manifestPath}`);
  });
});
