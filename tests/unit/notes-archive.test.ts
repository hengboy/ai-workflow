import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initializeProject } from '../../src/install/index.js';
import { sealArchive } from '../../src/notes/archive.js';
import { validateNotes } from '../../src/notes/validate.js';
import { temporary } from '../helpers.js';

const manifestPath = '.ai-workflow/notes/archived/manifest.json';
const archivedNotePath = '.ai-workflow/notes/archived/process/2026-09-17-archived-decision.md';
const archivedNoteKey = 'archived/process/2026-09-17-archived-decision.md';

// A note already moved to archived/ with the required Archived date. Sealing
// must register these exact bytes, not rewrite them.
const archivedNote = `# Agent Note: archived-decision

Status: implemented
Archived: 2026-09-17

## Problem

A delivered decision no longer guides future work.

## Decision

Archive the delivered record without rewriting it.

## Alternatives considered

- Deleting the record was declined because it still explains ownership.

## Consequences

- Sealed bytes are protected by the archive manifest.
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

async function sealedFixture(prefix: string): Promise<string> {
  const root = await temporary(prefix);
  await initializeProject(root);
  await writeFile(join(root, archivedNotePath), archivedNote);
  return root;
}

describe('notes archive sealing', () => {
  it('AC-009 registers a moved archived note by notes-root-relative path with its independent sha256 and then validates', async () => {
    const root = await sealedFixture('ai-workflow-notes-seal-');

    const result = await sealArchive(root);

    expect(result).toEqual({ sealed: [archivedNoteKey] });
    expect(JSON.parse(await readFile(join(root, manifestPath), 'utf8'))).toEqual({
      version: 1,
      files: { [archivedNoteKey]: independentDigest(archivedNote) },
    });
    expect(await readFile(join(root, archivedNotePath), 'utf8')).toBe(archivedNote);
    expect(await validateNotes(root)).toEqual({ valid: true, errors: [] });
  });

  it('AC-009 makes repeated sealing with no new records byte-identical', async () => {
    const root = await sealedFixture('ai-workflow-notes-seal-idempotent-');
    await sealArchive(root);
    const before = await snapshot(root);

    const result = await sealArchive(root);

    expect(result).toEqual({ sealed: [] });
    expect(await snapshot(root)).toEqual(before);
    expect(await validateNotes(root)).toEqual({ valid: true, errors: [] });
  });
});
