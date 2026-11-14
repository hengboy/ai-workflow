import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  checkTemplateFragments,
  formatTemplateFragmentCheck,
  writeTemplateFragments,
  type TemplateFragmentCheckResult,
} from '../../src/ops/template-fragments.js';
import { changedPaths, snapshotTree, temporary } from '../helpers.js';

/**
 * Template fragment public contract:
 *
 *   checkTemplateFragments(project: string): Promise<TemplateFragmentCheckResult>
 *   writeTemplateFragments(project: string): Promise<TemplateFragmentCheckResult>
 *   formatTemplateFragmentCheck(result): string
 *
 *   TemplateFragmentCheckResult = {
 *     valid: boolean;             // true only when `problems` is empty
 *     fragmentCount: number;      // canonical fragment files under templates/fragments
 *     occurrenceCount: number;    // total marked regions across shipped targets
 *     targetCount: number;        // shipped template files that contain at least one marker
 *     fragments: string[];        // sorted fragment names (file basename without .md)
 *     targets: string[];          // sorted project-relative target paths with markers
 *     problems: TemplateFragmentProblem[];
 *   }
 *
 *   TemplateFragmentProblem = {
 *     kind: 'drift' | 'unknown-fragment' | 'unpaired-marker' | 'duplicate-occurrence' | 'unused-fragment';
 *     path: string;               // exact project-relative target or fragment path
 *     fragment?: string;
 *     message: string;            // names the exact path
 *   }
 *
 * Marker grammar, one marker per line, `<name>` is the fragment basename without `.md`:
 *
 *   <!-- fragment:<name> -->
 *   ...fragment bytes...
 *   <!-- /fragment:<name> -->
 *
 * The region is the bytes strictly between the start line's newline and the end line;
 * it must byte-equal the fragment file bytes. Canonical fragments live under
 * `templates/fragments/`; shipped targets are Markdown files under `templates/`
 * excluding `templates/fragments/`. Zero fragments is valid. The checker is read-only;
 * `writeTemplateFragments` replaces only marked regions and preserves all unmarked text.
 */

const execFileAsync = promisify(execFile);
const temporaries: string[] = [];

afterEach(async () => {
  await Promise.all(temporaries.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const FRAGMENTS = 'templates/fragments';

function start(name: string): string {
  return `<!-- fragment:${name} -->`;
}

function end(name: string): string {
  return `<!-- /fragment:${name} -->`;
}

function marked(name: string, content: string): string {
  return `${start(name)}\n${content}${end(name)}\n`;
}

async function fixture(): Promise<string> {
  const root = await temporary('ai-workflow-template-fragments-');
  temporaries.push(root);
  return root;
}

async function writeAt(root: string, path: string, content: string): Promise<void> {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

async function writeFragment(root: string, name: string, content: string): Promise<void> {
  await writeAt(root, join(FRAGMENTS, `${name}.md`), content);
}

async function writeTarget(root: string, path: string, content: string): Promise<void> {
  await writeAt(root, join('templates/agents', path), content);
}

function kinds(result: TemplateFragmentCheckResult): string[] {
  return result.problems.map((problem) => problem.kind).sort();
}

function problemFor(result: TemplateFragmentCheckResult, kind: string, path: string) {
  const problem = result.problems.find((candidate) => candidate.kind === kind && candidate.path === path);
  if (!problem) throw new Error(`Missing ${kind} problem for ${path}`);
  return problem;
}

describe('checkTemplateFragments', () => {
  it('allows zero fragments before migration and writes nothing', async () => {
    const root = await fixture();
    await writeTarget(root, 'plain.md', '# Plain template\n\nNo markers yet.\n');
    const before = await snapshotTree(root);

    const result = await checkTemplateFragments(root);

    expect(result.valid).toBe(true);
    expect(result.fragmentCount).toBe(0);
    expect(result.occurrenceCount).toBe(0);
    expect(result.targetCount).toBe(0);
    expect(result.fragments).toEqual([]);
    expect(result.targets).toEqual([]);
    expect(result.problems).toEqual([]);
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  });

  it('passes when every marked region byte-equals its fragment and reports the counts', async () => {
    const root = await fixture();
    await writeFragment(root, 'alpha', 'Alpha body.\n');
    await writeFragment(root, 'beta', 'Beta body.\nSecond line.\n');
    await writeTarget(root, 'one.md', `# One\n\n${marked('alpha', 'Alpha body.\n')}\n${marked('beta', 'Beta body.\nSecond line.\n')}`);
    await writeTarget(root, 'two.md', `${marked('alpha', 'Alpha body.\n')}`);
    await writeAt(root, 'templates/skills/coding/SKILL.md', `${marked('beta', 'Beta body.\nSecond line.\n')}`);

    const result = await checkTemplateFragments(root);

    expect(result.valid).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.fragments).toEqual(['alpha', 'beta']);
    expect(result.targets).toEqual([
      'templates/agents/one.md',
      'templates/agents/two.md',
      'templates/skills/coding/SKILL.md',
    ]);
    expect(result.fragmentCount).toBe(2);
    expect(result.occurrenceCount).toBe(4);
    expect(result.targetCount).toBe(3);
  });

  it('fails with the target path when a marked copy drifts', async () => {
    const root = await fixture();
    await writeFragment(root, 'alpha', 'Alpha body.\n');
    await writeTarget(root, 'one.md', `# One\n\n${marked('alpha', 'Tampered body.\n')}`);
    const before = await snapshotTree(root);

    const result = await checkTemplateFragments(root);

    expect(result.valid).toBe(false);
    const problem = problemFor(result, 'drift', 'templates/agents/one.md');
    expect(problem.message).toContain('templates/agents/one.md');
    expect(formatTemplateFragmentCheck(result)).toContain('templates/agents/one.md');
    expect(changedPaths(before, await snapshotTree(root))).toEqual([]);
  });

  it('fails with the target path when a marker is unpaired', async () => {
    const root = await fixture();
    await writeFragment(root, 'alpha', 'Alpha body.\n');
    await writeTarget(root, 'one.md', `# One\n\n${start('alpha')}\nAlpha body.\n`);

    const result = await checkTemplateFragments(root);

    expect(result.valid).toBe(false);
    expect(problemFor(result, 'unpaired-marker', 'templates/agents/one.md').message).toContain('templates/agents/one.md');
  });

  it('fails with the target path and fragment name when a marker names an unknown fragment', async () => {
    const root = await fixture();
    await writeTarget(root, 'one.md', `${marked('ghost', 'Ghost body.\n')}`);

    const result = await checkTemplateFragments(root);

    expect(result.valid).toBe(false);
    const problem = problemFor(result, 'unknown-fragment', 'templates/agents/one.md');
    expect(problem.message).toContain('templates/agents/one.md');
    expect(problem.message).toContain('ghost');
  });

  it('fails with the target path when one file contains a duplicate occurrence', async () => {
    const root = await fixture();
    await writeFragment(root, 'alpha', 'Alpha body.\n');
    await writeTarget(root, 'one.md', `${marked('alpha', 'Alpha body.\n')}${marked('alpha', 'Alpha body.\n')}`);

    const result = await checkTemplateFragments(root);

    expect(result.valid).toBe(false);
    expect(problemFor(result, 'duplicate-occurrence', 'templates/agents/one.md').message).toContain('templates/agents/one.md');
  });

  it('fails with the fragment path when a fragment has no occurrence anywhere', async () => {
    const root = await fixture();
    await writeFragment(root, 'alpha', 'Alpha body.\n');
    await writeFragment(root, 'unused', 'Unused body.\n');
    await writeTarget(root, 'one.md', `${marked('alpha', 'Alpha body.\n')}`);

    const result = await checkTemplateFragments(root);

    expect(result.valid).toBe(false);
    expect(problemFor(result, 'unused-fragment', `${FRAGMENTS}/unused.md`).message).toContain(`${FRAGMENTS}/unused.md`);
  });
});

describe('writeTemplateFragments', () => {
  it('replaces only marked regions, preserves unmarked text and makes a subsequent check pass', async () => {
    const root = await fixture();
    await writeFragment(root, 'alpha', 'Alpha body.\n');
    const unmarkedHead = '# One\n\nKeep this.\n\n';
    const unmarkedTail = '\nKeep that too.\n';
    const target = join('templates/agents/one.md');
    await writeTarget(root, 'one.md', `${unmarkedHead}${marked('alpha', 'Drifted body.\n')}${unmarkedTail}`);
    const before = await snapshotTree(root);

    const drifted = await checkTemplateFragments(root);
    expect(drifted.valid).toBe(false);
    expect(kinds(drifted)).toContain('drift');

    const written = await writeTemplateFragments(root);
    expect(written.valid).toBe(true);

    const expected = `${unmarkedHead}${marked('alpha', 'Alpha body.\n')}${unmarkedTail}`;
    expect(await readFile(join(root, target), 'utf8')).toBe(expected);
    expect(changedPaths(before, await snapshotTree(root))).toEqual([target]);

    const rechecked = await checkTemplateFragments(root);
    expect(rechecked.valid).toBe(true);
    expect(rechecked.fragmentCount).toBe(1);
    expect(rechecked.occurrenceCount).toBe(1);
    expect(rechecked.targetCount).toBe(1);
  });
});

describe('check:templates script', () => {
  it('declares the script and includes it in check', async () => {
    const scripts = await readFile(join(process.cwd(), 'package.json'), 'utf8').then((contents) => {
      const parsed = JSON.parse(contents) as { scripts?: Record<string, string> };
      return parsed.scripts ?? {};
    });

    expect(scripts['check:templates']).toMatch(/check-templates/);
    expect(scripts.check).toContain('check:templates');
    await access(join(process.cwd(), 'scripts/check-templates.ts'));
  });

  it('restores drift through the explicit --write mode and then checks clean', async () => {
    const root = await fixture();
    await writeFragment(root, 'alpha', 'Alpha body.\n');
    const head = '# One\n\nKeep this.\n\n';
    const tail = '\nKeep that too.\n';
    const target = 'templates/agents/one.md';
    await writeTarget(root, 'one.md', `${head}${marked('alpha', 'Drifted body.\n')}${tail}`);

    const tsx = join(process.cwd(), 'node_modules/.bin/tsx');
    const script = join(process.cwd(), 'scripts/check-templates.ts');

    await execFileAsync(tsx, [script, '--write'], { cwd: root, timeout: 30_000 });
    expect(await readFile(join(root, target), 'utf8')).toBe(`${head}${marked('alpha', 'Alpha body.\n')}${tail}`);
    await execFileAsync(tsx, [script], { cwd: root, timeout: 30_000 });
  });
});
