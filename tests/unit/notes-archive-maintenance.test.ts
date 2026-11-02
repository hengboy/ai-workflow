import { describe, expect, it } from 'vitest';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { initializeProject } from '../../src/install/index.js';
import { sealArchive } from '../../src/notes/archive.js';
import { validateNotes } from '../../src/notes/validate.js';
import { listNotes } from '../../src/notes/index.js';
import { blobHash, metaPathOf, renderPairMeta, zhPathOf } from '../../src/notes/pairing.js';
import { temporary } from '../helpers.js';

const archivedPath = '.ai-workflow/notes/archived/process/2026-09-17-archived-decision.md';

function archivedBody(archivedDate: string): string {
  return `# Agent Note: archived-decision

Status: implemented
Archived: ${archivedDate}

English | [中文](2026-09-17-archived-decision.zh.md)

## Problem

Historical.

## Decision

Kept.

## Alternatives considered

- None.

## Consequences

- Sealed.
`;
}

function chineseArchivedBody(archivedDate: string): string {
  return `# Agent Note: archived-decision

Status: implemented
Archived: ${archivedDate}

[English](2026-09-17-archived-decision.md) | 中文

## Problem

历史。

## Decision

保留。

## Alternatives considered

- 无。

## Consequences

- 已封存。
`;
}

async function writeArchivedTriplet(root: string, enBody: string, zhBody: string): Promise<void> {
  await mkdir(join(root, '.ai-workflow/notes/archived/process'), { recursive: true });
  await writeFile(join(root, archivedPath), enBody);
  await writeFile(join(root, zhPathOf(archivedPath)), zhBody);
  await writeFile(join(root, metaPathOf(archivedPath)), renderPairMeta(archivedPath, blobHash(enBody), blobHash(zhBody)));
}

describe('notes archive maintenance', () => {
  it('rejects sealing and validation when bilingual Archived dates differ', async () => {
    const root = await temporary('ai-workflow-archive-maint-');
    await initializeProject(root);
    await writeArchivedTriplet(root, archivedBody('2026-09-17'), chineseArchivedBody('2026-09-18'));

    await expect(sealArchive(root)).rejects.toThrow();
    const result = await validateNotes(root);
    expect(result.valid).toBe(false);
  });

  it('rejects an Archived date earlier than the filename proposal date', async () => {
    const root = await temporary('ai-workflow-archive-maint-');
    await initializeProject(root);
    await writeArchivedTriplet(root, archivedBody('2026-09-16'), chineseArchivedBody('2026-09-16'));

    await expect(sealArchive(root)).rejects.toThrow();
    const result = await validateNotes(root);
    expect(result.valid).toBe(false);
  });

  it('seals and validates historical non-current formats in archive without byte changes, while active fails', async () => {
    const root = await temporary('ai-workflow-archive-maint-');
    await initializeProject(root);
    const historical = `# Agent Note: archived-decision


Status: implemented
Archived: 2026-09-17


English | [中文](2026-09-17-archived-decision.zh.md)


## Context

Historical layout that is not the current chapter set.
`;
    const historicalZh = `# Agent Note: archived-decision


Status: implemented
Archived: 2026-09-17


[English](2026-09-17-archived-decision.md) | 中文


## Context

历史布局，不是当前章节集合。
`;
    await writeArchivedTriplet(root, historical, historicalZh);
    const beforeEn = await readFile(join(root, archivedPath), 'utf8');
    const beforeZh = await readFile(join(root, zhPathOf(archivedPath)), 'utf8');

    const result = await sealArchive(root);
    expect(result.sealed).toContain('archived/process/2026-09-17-archived-decision.md');
    expect(await validateNotes(root)).toEqual({ valid: true, errors: [] });
    expect(await readFile(join(root, archivedPath), 'utf8')).toBe(beforeEn);
    expect(await readFile(join(root, zhPathOf(archivedPath)), 'utf8')).toBe(beforeZh);

    const archivedList = await listNotes(root, { archived: true });
    expect(archivedList).toHaveLength(1);
    expect(archivedList[0]?.title).toBe('archived-decision');
    expect(archivedList[0]?.status).toBe('implemented');
    expect(await listNotes(root)).toHaveLength(0);

    const activeRoot = await temporary('ai-workflow-archive-maint-active-');
    await initializeProject(activeRoot);
    const activePath = '.ai-workflow/notes/proposed/feature/2026-09-17-archived-decision.md';
    const activeEn = historical.replace('Status: implemented\nArchived: 2026-09-17', 'Status: proposed').replace(/\nArchived: 2026-09-17/, '');
    const activeZh = historicalZh.replace('Status: implemented\nArchived: 2026-09-17', 'Status: proposed').replace(/\nArchived: 2026-09-17/, '');
    await mkdir(join(activeRoot, '.ai-workflow/notes/proposed/feature'), { recursive: true });
    await writeFile(join(activeRoot, activePath), activeEn);
    await writeFile(join(activeRoot, zhPathOf(activePath)), activeZh);
    await writeFile(join(activeRoot, metaPathOf(activePath)), renderPairMeta(activePath, blobHash(activeEn), blobHash(activeZh)));
    const activeResult = await validateNotes(activeRoot);
    expect(activeResult.valid).toBe(false);
  });
});
