import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
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
});
