import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { initializeProject } from '../../src/install/index.js';
import { temporary, writeNoteTriplet, gitInit } from '../helpers.js';
import { zhPathOf, metaPathOf } from '../../src/notes/pairing.js';

const exec = promisify(execFile);
const cli = ['exec', 'tsx', 'src/cli.ts'] as const;
const manifestPath = '.ai-workflow/notes/archived/manifest.json';
const archivedNotePath = '.ai-workflow/notes/archived/testing/2026-04-01-historical-decision.md';
const archivedNoteKey = 'archived/testing/2026-04-01-historical-decision.md';
const archivedZhKey = 'archived/testing/2026-04-01-historical-decision.zh.md';
const archivedMetaKey = 'archived/testing/2026-04-01-historical-decision.i18n.yaml';

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

const secondNotePath = '.ai-workflow/notes/archived/testing/2026-04-02-second-decision.md';
const secondNoteKey = 'archived/testing/2026-04-02-second-decision.md';

const secondNote = `# Agent Note: second-decision

Status: implemented
Archived: 2026-05-02

## Problem

A second delivered decision.

## Decision

Keep the second record as frozen history.

## Alternatives considered

- Deleting the record was declined to preserve the rationale.

## Consequences

- The sealed bytes are registered in the archive manifest.
`;

function digest(contents: string): string {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`;
}

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

async function headSha(repoRoot: string): Promise<string> {
  const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
  return stdout.trim();
}

async function commitAll(repoRoot: string, message: string): Promise<void> {
  await exec('git', ['add', '-A'], { cwd: repoRoot });
  await exec('git', ['commit', '-m', message], { cwd: repoRoot });
}

describe('notes archive baseline CLI', () => {
  it('rejects a tampered sealed archive against an older base with path and hash-changed meaning', async () => {
    const project = await temporary('ai-workflow-notes-baseline-tamper-');
    await gitInit(project);
    await initializeProject(project);
    await writeNoteTriplet(project, archivedNotePath, archivedNote);
    const sealResult = await runCli(project, ['notes', 'archive', '--project', project, '--seal']);
    expect(sealResult.code).toBe(0);
    await commitAll(project, 'seal baseline');
    const base = await headSha(project);

    const tamperedBody = archivedNote.replace('A delivered decision stopped guiding future work.', 'A silently rewritten problem statement.');
    const triplet = await writeNoteTriplet(project, archivedNotePath, tamperedBody);
    const manifest = JSON.parse(await readFile(join(project, manifestPath), 'utf8')) as { version: number; files: Record<string, string> };
    manifest.files[archivedNoteKey] = digest(triplet.english);
    manifest.files[archivedZhKey] = digest(triplet.chinese);
    manifest.files[archivedMetaKey] = digest(triplet.meta);
    await writeFile(join(project, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`);

    const validNow = await runCli(project, ['notes', 'validate', '--project', project]);
    expect(validNow.code).toBe(0);
    const validParsed = JSON.parse(validNow.stdout) as { valid: boolean; errors: string[] };
    expect(validParsed).toEqual({ valid: true, errors: [] });

    await commitAll(project, 'tamper archive');
    expect(await headSha(project)).not.toBe(base);

    const result = await runCli(project, ['notes', 'validate', '--project', project, '--base', base]);
    expect(result.code).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as { valid: boolean; errors: string[] };
    expect(parsed.valid).toBe(false);
    expect(parsed.errors.some((error) => error.includes(archivedNoteKey))).toBe(true);
    expect(parsed.errors.some((error) => /baseline|hash|changed|sealed/i.test(error))).toBe(true);

    const manifestBefore = await readFile(join(project, manifestPath), 'utf8');
    const sealReject = await runCli(project, ['notes', 'archive', '--project', project, '--seal', '--base', base]);
    expect(sealReject.code).not.toBe(0);
    expect(await readFile(join(project, manifestPath), 'utf8')).toBe(manifestBefore);
  });

  it('rejects a deleted sealed triplet against an older base', async () => {
    const project = await temporary('ai-workflow-notes-baseline-delete-');
    await gitInit(project);
    await initializeProject(project);
    await writeNoteTriplet(project, archivedNotePath, archivedNote);
    const sealResult = await runCli(project, ['notes', 'archive', '--project', project, '--seal']);
    expect(sealResult.code).toBe(0);
    await commitAll(project, 'seal baseline');
    const base = await headSha(project);

    await rm(join(project, archivedNotePath));
    await rm(join(project, zhPathOf(archivedNotePath)));
    await rm(join(project, metaPathOf(archivedNotePath)));
    const manifest = JSON.parse(await readFile(join(project, manifestPath), 'utf8')) as { version: number; files: Record<string, string> };
    delete manifest.files[archivedNoteKey];
    delete manifest.files[archivedZhKey];
    delete manifest.files[archivedMetaKey];
    await writeFile(join(project, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`);

    const validNow = await runCli(project, ['notes', 'validate', '--project', project]);
    expect(validNow.code).toBe(0);
    const validParsed = JSON.parse(validNow.stdout) as { valid: boolean; errors: string[] };
    expect(validParsed).toEqual({ valid: true, errors: [] });

    const validateReject = await runCli(project, ['notes', 'validate', '--project', project, '--base', base]);
    expect(validateReject.code).not.toBe(0);
    const validateParsed = JSON.parse(validateReject.stdout) as { valid: boolean; errors: string[] };
    expect(validateParsed.valid).toBe(false);
    expect(validateParsed.errors.some((error) => error.includes(archivedNoteKey))).toBe(true);

    const manifestBefore = await readFile(join(project, manifestPath), 'utf8');
    const sealReject = await runCli(project, ['notes', 'archive', '--project', project, '--seal', '--base', base]);
    expect(sealReject.code).not.toBe(0);
    expect(await readFile(join(project, manifestPath), 'utf8')).toBe(manifestBefore);
  });

  it('appends a legitimate triplet while preserving old seals', async () => {
    const project = await temporary('ai-workflow-notes-baseline-append-');
    await gitInit(project);
    await initializeProject(project);
    const first = await writeNoteTriplet(project, archivedNotePath, archivedNote);
    const sealResult = await runCli(project, ['notes', 'archive', '--project', project, '--seal']);
    expect(sealResult.code).toBe(0);
    await commitAll(project, 'seal baseline');
    const base = await headSha(project);

    const oldEnglish = await readFile(join(project, archivedNotePath), 'utf8');
    const oldChinese = await readFile(join(project, zhPathOf(archivedNotePath)), 'utf8');
    const oldMeta = await readFile(join(project, metaPathOf(archivedNotePath)), 'utf8');

    await writeNoteTriplet(project, secondNotePath, secondNote);
    const appendSeal = await runCli(project, ['notes', 'archive', '--project', project, '--seal', '--base', base]);
    expect(appendSeal.code).toBe(0);
    const sealed = JSON.parse(appendSeal.stdout) as { sealed: string[] };
    expect(sealed.sealed).toContain(secondNoteKey);

    const validateResult = await runCli(project, ['notes', 'validate', '--project', project, '--base', base]);
    expect(validateResult.code).toBe(0);
    const validated = JSON.parse(validateResult.stdout) as { valid: boolean; errors: string[] };
    expect(validated).toEqual({ valid: true, errors: [] });

    const manifest = JSON.parse(await readFile(join(project, manifestPath), 'utf8')) as { files: Record<string, string> };
    expect(manifest.files[archivedNoteKey]).toBe(digest(first.english));

    expect(await readFile(join(project, archivedNotePath), 'utf8')).toBe(oldEnglish);
    expect(await readFile(join(project, zhPathOf(archivedNotePath)), 'utf8')).toBe(oldChinese);
    expect(await readFile(join(project, metaPathOf(archivedNotePath)), 'utf8')).toBe(oldMeta);
  });

  it('fails validate and does not seal for an invalid base', async () => {
    const project = await temporary('ai-workflow-notes-baseline-invalid-');
    await gitInit(project);
    await initializeProject(project);
    await writeNoteTriplet(project, archivedNotePath, archivedNote);
    const sealResult = await runCli(project, ['notes', 'archive', '--project', project, '--seal']);
    expect(sealResult.code).toBe(0);
    await commitAll(project, 'seal baseline');

    const invalidBase = '0'.repeat(40);
    const validateResult = await runCli(project, ['notes', 'validate', '--project', project, '--base', invalidBase]);
    expect(validateResult.code).not.toBe(0);
    const validateParsed = JSON.parse(validateResult.stdout) as { valid: boolean; errors: string[] };
    expect(validateParsed.valid).toBe(false);
    expect(validateParsed.errors.some((error) => /baseline|ref/i.test(error))).toBe(true);

    const manifestBefore = await readFile(join(project, manifestPath), 'utf8');
    const sealResult2 = await runCli(project, ['notes', 'archive', '--project', project, '--seal', '--base', invalidBase]);
    expect(sealResult2.code).not.toBe(0);
    expect(sealResult2.stderr).toMatch(/base/i);
    expect(sealResult2.stderr).not.toMatch(/unknown option/i);
    expect(await readFile(join(project, manifestPath), 'utf8')).toBe(manifestBefore);
  });

  it('accepts a baseline commit that has no notes manifest', async () => {
    const project = await temporary('ai-workflow-notes-baseline-init-');
    await gitInit(project);
    const base = await headSha(project);

    await initializeProject(project);
    await writeNoteTriplet(project, archivedNotePath, archivedNote);
    const sealResult = await runCli(project, ['notes', 'archive', '--project', project, '--seal']);
    expect(sealResult.code).toBe(0);

    const validateResult = await runCli(project, ['notes', 'validate', '--project', project, '--base', base]);
    expect(validateResult.code).toBe(0);
    const validated = JSON.parse(validateResult.stdout) as { valid: boolean; errors: string[] };
    expect(validated).toEqual({ valid: true, errors: [] });

    const sealResult2 = await runCli(project, ['notes', 'archive', '--project', project, '--seal', '--base', base]);
    expect(sealResult2.code).toBe(0);
  });

  it('uses the project-relative repository location for a project in a subdirectory', async () => {
    const repoRoot = await temporary('ai-workflow-notes-baseline-subdir-repo-');
    await gitInit(repoRoot);
    const project = join(repoRoot, 'nested', 'project');
    await mkdir(project, { recursive: true });
    await initializeProject(project);
    await writeNoteTriplet(project, archivedNotePath, archivedNote);
    const sealResult = await runCli(project, ['notes', 'archive', '--project', project, '--seal']);
    expect(sealResult.code).toBe(0);
    await commitAll(repoRoot, 'seal baseline in subdir');
    const base = await headSha(repoRoot);

    const positive = await runCli(project, ['notes', 'validate', '--project', project, '--base', base]);
    expect(positive.code).toBe(0);
    const parsed = JSON.parse(positive.stdout) as { valid: boolean; errors: string[] };
    expect(parsed).toEqual({ valid: true, errors: [] });

    const tamperedBody = archivedNote.replace('A delivered decision stopped guiding future work.', 'A silently rewritten problem statement.');
    const triplet = await writeNoteTriplet(project, archivedNotePath, tamperedBody);
    const manifest = JSON.parse(await readFile(join(project, manifestPath), 'utf8')) as { version: number; files: Record<string, string> };
    manifest.files[archivedNoteKey] = digest(triplet.english);
    manifest.files[archivedZhKey] = digest(triplet.chinese);
    manifest.files[archivedMetaKey] = digest(triplet.meta);
    await writeFile(join(project, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`);

    const negative = await runCli(project, ['notes', 'validate', '--project', project, '--base', base]);
    expect(negative.code).not.toBe(0);
    const parsedNegative = JSON.parse(negative.stdout) as { valid: boolean; errors: string[] };
    expect(parsedNegative.valid).toBe(false);
    expect(parsedNegative.errors.some((error) => error.includes(archivedNoteKey))).toBe(true);
  });
});
