import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { packagePath } from '../../src/utils/schema.js';

// Shipped-content evidence for single-source prompt fragments (REQ-007 / AC-011).
// These assertions read the delivered fragment files, README and marked templates.

const README = 'README.md';
const TEMPLATE_DIR = 'templates';
const FRAGMENT_DIR = 'templates/fragments';

const FRAGMENTS = [
  'findings-precedence',
  'packet-path-rules',
  'report-body-targets',
  'report-shape',
  'sync-hook-invocation',
  'sync-phase-entry',
] as const;

const START_MARKER = /^<!-- fragment:([^\s<>]+) -->$/;
const END_MARKER = /^<!-- \/fragment:([^\s<>]+) -->$/;

async function read(path: string): Promise<string> {
  return readFile(packagePath(path), 'utf8');
}

/** Whitespace-normalized text so assertions are insensitive to wrapping. */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

async function listMarkdown(directory: string): Promise<string[]> {
  const entries = await readdir(packagePath(directory), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of [...entries].sort((left, right) => (left.name < right.name ? -1 : 1))) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await listMarkdown(path)));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(path);
  }
  return files;
}

describe('template fragment files (REQ-007 / AC-011)', () => {
  it('ships exactly the six named non-empty fragment files', async () => {
    const entries = (await readdir(packagePath(FRAGMENT_DIR), { withFileTypes: true }))
      .map((entry) => entry.name)
      .sort();
    expect(entries, 'templates/fragments contains exactly the six canonical files').toEqual(
      FRAGMENTS.map((name) => `${name}.md`).sort(),
    );

    for (const name of FRAGMENTS) {
      const bytes = await read(`${FRAGMENT_DIR}/${name}.md`);
      expect(bytes.length, `${FRAGMENT_DIR}/${name}.md is non-empty`).toBeGreaterThan(0);
    }
  });
});

describe('README fragment convention (REQ-007 / AC-011)', () => {
  it('states the fragment rule, markers and the check:templates --write behavior', async () => {
    const readme = flatten(await read(README));

    expect(readme, 'README names the fragment directory convention').toMatch(
      /templates\/fragments\/<name>\.md/i,
    );
    expect(readme, 'README states the start marker syntax').toContain('<!-- fragment:<name> -->');
    expect(readme, 'README states the end marker syntax').toContain('<!-- /fragment:<name> -->');
    expect(readme, 'README names the check command').toMatch(/pnpm check:templates/i);
    expect(readme, 'README states the drift and marker failures').toMatch(
      /drift between a fragment and a marked copy[^.]{0,400}unknown fragment name[^.]{0,200}unpaired marker[^.]{0,200}duplicate occurrence[^.]{0,200}unused fragment file/i,
    );
    expect(readme, 'README states the explicit --write mode').toMatch(
      /check:templates --write[^.]{0,200}re-inlines only the marked regions/i,
    );
    expect(readme, 'README states that unmarked text is untouched').toMatch(
      /leaves all unmarked text untouched/i,
    );
  });
});

describe('delivered template markers (REQ-007 / AC-011)', () => {
  it('uses only the stable marker syntax with known, paired and used fragments', async () => {
    const targets = (await listMarkdown(TEMPLATE_DIR)).filter(
      (path) => !path.startsWith(`${FRAGMENT_DIR}/`),
    );
    expect(targets.length, 'shipped Markdown templates are present').toBeGreaterThan(0);

    const used = new Set<string>();
    let targetCount = 0;

    for (const path of targets) {
      const lines = (await read(path)).split('\n');
      const seen = new Set<string>();
      let open: string | undefined;
      let markerCount = 0;

      for (const raw of lines) {
        const line = raw.replace(/\r$/, '');
        const start = START_MARKER.exec(line);
        const end = END_MARKER.exec(line);
        if (line.includes('fragment:')) {
          expect(
            start !== null || end !== null,
            `${path} uses only the exact fragment marker syntax: ${line}`,
          ).toBe(true);
        }
        if (start?.[1] !== undefined) {
          markerCount += 1;
          expect(open, `${path} has no nested fragment marker`).toBeUndefined();
          expect(FRAGMENTS, `${path} names a known fragment`).toContain(start[1]);
          open = start[1];
        } else if (end?.[1] !== undefined) {
          markerCount += 1;
          expect(open, `${path} closes only an open fragment marker`).toBe(end[1]);
          expect(seen.has(end[1]), `${path} has no duplicate ${end[1]} occurrence`).toBe(false);
          seen.add(end[1]);
          used.add(end[1]);
          open = undefined;
        }
      }

      expect(open, `${path} has no unclosed fragment marker`).toBeUndefined();
      if (markerCount > 0) targetCount += 1;
    }

    expect(targetCount, 'shipped templates carry marked fragment regions').toBeGreaterThan(0);
    expect([...used].sort(), 'every canonical fragment has at least one marked occurrence').toEqual(
      [...FRAGMENTS].sort(),
    );
  });
});
