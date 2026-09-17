import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
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

  // The counterexamples below prove that sealing protects existing history
  // instead of accepting a rewritten archive. They are regression guards: the
  // behavior was implemented before this test slice was added.

  const unregisteredNotePath = '.ai-workflow/notes/archived/architecture/2026-09-18-unsealed-decision.md';

  function archivedDecision(title: string, archived: string): string {
    return `# Agent Note: ${title}

Status: implemented
Archived: ${archived}

## Problem

A delivered decision no longer guides future work.

## Decision

Archive the delivered record without rewriting it.

## Alternatives considered

- Deleting the record was declined because it still explains ownership.

## Consequences

- Sealed bytes are protected by the archive manifest.
`;
  }

  it('AC-009 fails validation with a file-level reason after a sealed body is tampered and leaves the file as written', async () => {
    const root = await sealedFixture('ai-workflow-notes-seal-tamper-');
    await sealArchive(root);
    const tampered = archivedNote.replace('Sealed bytes are protected by the archive manifest.', 'Sealed bytes were silently rewritten.');
    await writeFile(join(root, archivedNotePath), tampered);

    const result = await validateNotes(root);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(`${archivedNoteKey}: archived note bytes differ from the manifest digest`);
    expect(await readFile(join(root, archivedNotePath), 'utf8')).toBe(tampered);
  });

  it('AC-009 fails validation with a manifest-level reason after a sealed note is deleted', async () => {
    const root = await sealedFixture('ai-workflow-notes-seal-delete-');
    await sealArchive(root);
    const manifestBefore = await readFile(join(root, manifestPath), 'utf8');
    await rm(join(root, archivedNotePath));

    const result = await validateNotes(root);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(`${manifestPath}: entry ${archivedNoteKey} has no archived note`);
    expect(await readFile(join(root, manifestPath), 'utf8')).toBe(manifestBefore);
  });

  it('AC-009 fails validation after a sealed note is moved or renamed into another class', async () => {
    const root = await sealedFixture('ai-workflow-notes-seal-move-');
    await sealArchive(root);
    const movedPath = '.ai-workflow/notes/archived/testing/2026-09-17-archived-decision.md';
    await rename(join(root, archivedNotePath), join(root, movedPath));

    const result = await validateNotes(root);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(`${manifestPath}: entry ${archivedNoteKey} has no archived note`);
    expect(result.errors).toContain(`${movedPath}: archived note is not registered in ${manifestPath}`);
  });

  it('AC-009 fails validation for an archived note that has no manifest entry', async () => {
    const root = await sealedFixture('ai-workflow-notes-seal-extra-');
    await sealArchive(root);
    const unsealed = archivedDecision('unsealed-decision', '2026-09-18');
    await writeFile(join(root, unregisteredNotePath), unsealed);
    const manifestBefore = await readFile(join(root, manifestPath), 'utf8');

    const result = await validateNotes(root);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(`${unregisteredNotePath}: archived note is not registered in ${manifestPath}`);
    expect(await readFile(join(root, unregisteredNotePath), 'utf8')).toBe(unsealed);
    expect(await readFile(join(root, manifestPath), 'utf8')).toBe(manifestBefore);
  });

  it('AC-009 fails validation for a sealed archived note with a wrong status or archived date', async () => {
    const statusRoot = await sealedFixture('ai-workflow-notes-seal-status-');
    await sealArchive(statusRoot);
    await writeFile(join(statusRoot, archivedNotePath), archivedNote.replace('Status: implemented', 'Status: archived'));

    const statusResult = await validateNotes(statusRoot);

    expect(statusResult.valid).toBe(false);
    expect(statusResult.errors).toContain(`${archivedNotePath}: Status must be implemented for lifecycle archived`);

    const dateRoot = await sealedFixture('ai-workflow-notes-seal-date-');
    await sealArchive(dateRoot);
    await writeFile(join(dateRoot, archivedNotePath), archivedNote.replace('Archived: 2026-09-17', 'Archived: 2026-02-31'));

    const dateResult = await validateNotes(dateRoot);

    expect(dateResult.valid).toBe(false);
    expect(dateResult.errors).toContain(`${archivedNotePath}: Archived must immediately follow Status with a real YYYY-MM-DD date`);
  });

  it('AC-009 rejects sealing a changed old note without touching the old entry or accepting the change', async () => {
    const root = await sealedFixture('ai-workflow-notes-seal-refuse-');
    await sealArchive(root);
    const manifestBefore = await readFile(join(root, manifestPath), 'utf8');
    const tampered = archivedNote.replace('Sealed bytes are protected by the archive manifest.', 'Sealed bytes were silently rewritten.');
    await writeFile(join(root, archivedNotePath), tampered);
    const unsealed = archivedDecision('unsealed-decision', '2026-09-18');
    await writeFile(join(root, unregisteredNotePath), unsealed);

    await expect(sealArchive(root)).rejects.toThrow(/sealed archived note bytes changed/);

    expect(await readFile(join(root, manifestPath), 'utf8')).toBe(manifestBefore);
    expect(JSON.parse(manifestBefore).files[archivedNoteKey]).toBe(independentDigest(archivedNote));
    expect(await readFile(join(root, archivedNotePath), 'utf8')).toBe(tampered);
    expect(await readFile(join(root, unregisteredNotePath), 'utf8')).toBe(unsealed);

    const result = await validateNotes(root);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(`${archivedNoteKey}: archived note bytes differ from the manifest digest`);
    expect(result.errors).toContain(`${unregisteredNotePath}: archived note is not registered in ${manifestPath}`);
  });
});
