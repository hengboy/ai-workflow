import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { initializeProject } from '../../src/install/index.js';
import { temporary } from '../helpers.js';

const exec = promisify(execFile);
const cli = ['exec', 'tsx', 'src/cli.ts'] as const;
const notesFiles = [
  '.ai-workflow/AGENTS.md',
  '.ai-workflow/notes/AGENTS.md',
  '.ai-workflow/notes/README.md',
  '.ai-workflow/notes/implemented/AGENTS.md',
  '.ai-workflow/notes/archived/AGENTS.md',
  '.ai-workflow/notes/archived/manifest.json',
] as const;

async function noteBytes(root: string): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(notesFiles.map(async (path) => [path, await readFile(join(root, path), 'utf8')])));
}

type Section = [heading: string, body: string];

function agentNote(title: string, status: string, sections: Section[], archived?: string): string {
  const lines = [`# Agent Note: ${title}`, '', `Status: ${status}`];
  if (archived) lines.push(`Archived: ${archived}`);
  for (const [heading, body] of sections) lines.push('', `## ${heading}`, '', body);
  return `${lines.join('\n')}\n`;
}

const proposedSections: Section[] = [
  ['Problem', 'The current structure cannot express an unimplemented decision.'],
  ['Proposal', 'Record the proposal before implementation begins.'],
  ['Alternatives considered', '- Deferring the record was declined because the rationale would be lost.'],
  ['Acceptance criteria', '- The proposal is discoverable by lifecycle, class and date.'],
  ['Risks', '- A stale proposal must later be rejected rather than archived.'],
];
const implementedSections: Section[] = [
  ['Problem', 'Delivered decisions had no single current record.'],
  ['Decision', 'Store implemented decisions under implemented/{class}/.'],
  ['Alternatives considered', '- Keeping records in chat history was declined as untraceable.'],
  ['Consequences', '- Implemented records must stay current with the code they describe.'],
];
const rejectedSections: Section[] = [
  ['Problem', 'A proposal duplicates an existing decision.'],
  ['Proposal', 'Keep both records active.'],
  ['Alternatives considered', '- Merging the text was declined in favour of a clear rejection reason.'],
];
const archivedSections: Section[] = [
  ['Problem', 'A delivered decision no longer guides future work.'],
  ['Decision', 'Archive the delivered record without rewriting it.'],
  ['Alternatives considered', '- Deleting the record was declined to preserve history.'],
  ['Consequences', '- Sealed bytes are protected by the archive manifest.'],
];

// Written in an order that differs from the expected relative-path order so the
// sort is exercised rather than incidental, and ordered so path sort differs
// from date sort.
const activeEntries = [
  {
    path: '.ai-workflow/notes/implemented/process/2026-02-01-delivered-decision.md',
    title: 'Delivered decision',
    lifecycle: 'implemented',
    class: 'process',
    date: '2026-02-01',
    status: 'implemented',
  },
  {
    path: '.ai-workflow/notes/proposed/architecture/2026-01-02-second-proposal.md',
    title: 'Second proposal',
    lifecycle: 'proposed',
    class: 'architecture',
    date: '2026-01-02',
    status: 'proposed',
  },
  {
    path: '.ai-workflow/notes/proposed/feature/2026-01-01-first-proposal.md',
    title: 'First proposal',
    lifecycle: 'proposed',
    class: 'feature',
    date: '2026-01-01',
    status: 'proposed',
  },
  {
    path: '.ai-workflow/notes/rejected/bug-fix/2026-03-01-rejected-idea.md',
    title: 'Rejected idea',
    lifecycle: 'rejected',
    class: 'bug-fix',
    date: '2026-03-01',
    status: 'rejected — duplicate of proposal',
  },
];

const archivedEntry = {
  path: '.ai-workflow/notes/archived/testing/2026-04-01-historical-decision.md',
  title: 'Historical decision',
  lifecycle: 'archived',
  class: 'testing',
  date: '2026-04-01',
  status: 'implemented',
};

async function populateNotes(root: string): Promise<void> {
  const notes: Array<[string, string]> = [
    ['.ai-workflow/notes/proposed/feature/2026-01-01-first-proposal.md', agentNote('First proposal', 'proposed', proposedSections)],
    ['.ai-workflow/notes/rejected/bug-fix/2026-03-01-rejected-idea.md', agentNote('Rejected idea', 'rejected — duplicate of proposal', rejectedSections)],
    ['.ai-workflow/notes/implemented/process/2026-02-01-delivered-decision.md', agentNote('Delivered decision', 'implemented', implementedSections)],
    ['.ai-workflow/notes/archived/testing/2026-04-01-historical-decision.md', agentNote('Historical decision', 'implemented', archivedSections, '2026-05-01')],
    ['.ai-workflow/notes/proposed/architecture/2026-01-02-second-proposal.md', agentNote('Second proposal', 'proposed', proposedSections)],
  ];
  for (const [path, contents] of notes) await writeFile(join(root, path), contents);
}

async function listFixture(prefix: string): Promise<string> {
  const root = await temporary(prefix);
  await initializeProject(root);
  await populateNotes(root);
  return root;
}

async function aiWorkflowBytes(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  async function walk(relative: string): Promise<void> {
    const entries = await readdir(join(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) snapshot[path] = (await readFile(join(root, path))).toString('base64');
    }
  }
  await walk('.ai-workflow');
  return snapshot;
}

describe('notes CLI', () => {
  it('AC-004 validates an initialized empty notes tree without changing its files', async () => {
    const project = await temporary('ai-workflow-notes-validate-');
    await initializeProject(project);
    const before = await noteBytes(project);

    const { stdout } = await exec('pnpm', [...cli, 'notes', 'validate', '--project', project]);

    expect(JSON.parse(stdout)).toEqual({ valid: true, errors: [] });
    expect(await noteBytes(project)).toEqual(before);
  });

  it('AC-004 lists an initialized empty notes tree as empty', async () => {
    const project = await temporary('ai-workflow-notes-list-empty-');
    await initializeProject(project);

    const active = (await exec('pnpm', [...cli, 'notes', 'list', '--project', project])).stdout;
    const withArchived = (await exec('pnpm', [...cli, 'notes', 'list', '--project', project, '--archived'])).stdout;

    expect(JSON.parse(active)).toEqual({ entries: [] });
    expect(JSON.parse(withArchived)).toEqual({ entries: [] });
  });

  it('AC-010 lists only active notes with the documented fields in stable relative-path order', async () => {
    const project = await listFixture('ai-workflow-notes-list-active-');

    const first = (await exec('pnpm', [...cli, 'notes', 'list', '--project', project])).stdout;

    expect(JSON.parse(first)).toEqual({ entries: activeEntries });

    const second = (await exec('pnpm', [...cli, 'notes', 'list', '--project', project])).stdout;

    expect(second).toBe(first);
  });

  it('AC-010 includes archived notes only when --archived is given', async () => {
    const project = await listFixture('ai-workflow-notes-list-archived-');

    const active = (await exec('pnpm', [...cli, 'notes', 'list', '--project', project])).stdout;

    expect(JSON.parse(active)).toEqual({ entries: activeEntries });

    const withArchived = (await exec('pnpm', [...cli, 'notes', 'list', '--project', project, '--archived'])).stdout;

    expect(JSON.parse(withArchived)).toEqual({ entries: [archivedEntry, ...activeEntries] });
  });

  it('AC-010 reads no legacy ADR records and creates no index files', async () => {
    const project = await listFixture('ai-workflow-notes-list-adr-');
    await mkdir(join(project, '.ai-workflow/adr'), { recursive: true });
    await writeFile(join(project, '.ai-workflow/adr/0001-legacy-decision.md'), '# Agent Note: Legacy ADR lookalike\n\nStatus: proposed\n\n## Problem\n\nHistorical decision store.\n');
    await writeFile(join(project, '.ai-workflow/adr/INDEX.md'), '# hand-written stale index\n');
    const before = await aiWorkflowBytes(project);

    const active = (await exec('pnpm', [...cli, 'notes', 'list', '--project', project])).stdout;
    const withArchived = (await exec('pnpm', [...cli, 'notes', 'list', '--project', project, '--archived'])).stdout;

    expect(JSON.parse(active)).toEqual({ entries: activeEntries });
    expect(active).not.toContain('adr');
    expect(active).not.toContain('legacy-decision');
    expect(withArchived).not.toContain('legacy-decision');
    expect(await aiWorkflowBytes(project)).toEqual(before);
  });
});
