import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { initializeProject } from '../../src/install/index.js';
import { validateNotes } from '../../src/notes/validate.js';
import { temporary } from '../helpers.js';

const proposed = `# Agent Note: improve-validation

Status: proposed

## Problem

The validation gap is recorded.

## Proposal

Validate the note format mechanically.

## Alternatives considered

Manual review alone was declined because it misses mechanical mistakes.

## Acceptance criteria

Malformed notes fail validation.

## Risks

The validator could reject a valid note.
`;

const implemented = `# Agent Note: validation-delivered

Status: implemented

## Problem

验证缺口已经记录。

## Decision

已交付格式校验。

## Alternatives considered

仅人工审查被放弃，因为无法稳定发现格式错误。

## Consequences

无效记录会被拒绝。
`;

const rejected = `# Agent Note: declined-approach

Status: rejected — too costly for the current change

## Problem

The problem is recorded.

## Proposal

Adopt the approach.

## Alternatives considered

The smaller change was preferred because it meets the need.
`;

type NoteCase = {
  name: string;
  path: string;
  contents: string;
  valid: boolean;
  expectedReason?: RegExp;
};

describe('notes format validation', () => {
  it.each<NoteCase>([
    {
      name: 'accepts an English proposed note',
      path: '.ai-workflow/notes/proposed/feature/2026-09-17-improve-validation.md',
      contents: proposed,
      valid: true,
    },
    {
      name: 'accepts a Chinese implemented note',
      path: '.ai-workflow/notes/implemented/process/2026-09-17-validation-delivered.md',
      contents: implemented,
      valid: true,
    },
    {
      name: 'accepts a rejected note with a one-line reason',
      path: '.ai-workflow/notes/rejected/architecture/2026-09-17-declined-approach.md',
      contents: rejected,
      valid: true,
    },
    {
      name: 'rejects an unknown category',
      path: '.ai-workflow/notes/proposed/unknown/2026-09-17-improve-validation.md',
      contents: proposed,
      valid: false,
      expectedReason: /class|category|unsupported/i,
    },
    {
      name: 'rejects an impossible date in the file name',
      path: '.ai-workflow/notes/proposed/feature/2026-02-30-improve-validation.md',
      contents: proposed,
      valid: false,
      expectedReason: /date/i,
    },
    {
      name: 'rejects a non-kebab-case file name',
      path: '.ai-workflow/notes/proposed/feature/2026-09-17-improve_validation.md',
      contents: proposed,
      valid: false,
      expectedReason: /file name|kebab|naming/i,
    },
    {
      name: 'rejects a malformed fixed title header',
      path: '.ai-workflow/notes/proposed/feature/2026-09-17-improve-validation.md',
      contents: proposed.replace('# Agent Note:', '# Agent note:'),
      valid: false,
      expectedReason: /title|header/i,
    },
    {
      name: 'rejects a proposed note whose status belongs to another lifecycle',
      path: '.ai-workflow/notes/proposed/feature/2026-09-17-status-mismatch.md',
      contents: proposed.replace('Status: proposed', 'Status: implemented'),
      valid: false,
      expectedReason: /status.*proposed|proposed.*status|lifecycle/i,
    },
    {
      name: 'rejects a missing required section',
      path: '.ai-workflow/notes/proposed/feature/2026-09-17-missing-risks.md',
      contents: proposed.replace('\n## Risks\n\nThe validator could reject a valid note.\n', ''),
      valid: false,
      expectedReason: /risks|required section|section/i,
    },
    {
      name: 'rejects an empty required section',
      path: '.ai-workflow/notes/proposed/feature/2026-09-17-empty-risks.md',
      contents: proposed.replace('The validator could reject a valid note.', '   '),
      valid: false,
      expectedReason: /risks|empty|required section|section/i,
    },
    {
      name: 'rejects required sections out of order',
      path: '.ai-workflow/notes/proposed/feature/2026-09-17-out-of-order.md',
      contents: proposed.replace('## Proposal\n\nValidate the note format mechanically.\n\n## Alternatives considered\n\nManual review alone was declined because it misses mechanical mistakes.', '## Alternatives considered\n\nManual review alone was declined because it misses mechanical mistakes.\n\n## Proposal\n\nValidate the note format mechanically.'),
      valid: false,
      expectedReason: /order|proposal|alternatives/i,
    },
    ...['Proposal', 'Plan', 'Migration plan', 'Acceptance criteria'].map((section) => ({
      name: `rejects an implemented note retaining ${section}`,
      path: `.ai-workflow/notes/implemented/process/2026-09-17-retained-${section.toLowerCase().replace(/ /g, '-')}.md`,
      contents: `${implemented}\n## ${section}\n\nThis is an unimplemented planning section.\n`,
      valid: false,
      expectedReason: new RegExp(section, 'i'),
    })),
    {
      name: 'rejects a rejected note without a rejection reason',
      path: '.ai-workflow/notes/rejected/architecture/2026-09-17-missing-reason.md',
      contents: rejected.replace('Status: rejected — too costly for the current change', 'Status: rejected'),
      valid: false,
      expectedReason: /rejected.*reason|reason.*rejected|status/i,
    },
  ])('$name', async ({ path, contents, valid, expectedReason }) => {
    const project = await temporary('ai-workflow-notes-format-');
    await initializeProject(project);
    await mkdir(dirname(join(project, path)), { recursive: true });
    await writeFile(join(project, path), contents);

    const result = await validateNotes(project);

    expect(result.valid).toBe(valid);
    if (valid) {
      expect(result.errors).toEqual([]);
    } else {
      const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.stringMatching(new RegExp(`${escapedPath}.*${expectedReason!.source}`, 'i')),
      ]));
    }
    expect(await readFile(join(project, path), 'utf8')).toBe(contents);
  });
});

const activePath = '.ai-workflow/notes/proposed/feature/2026-09-17-improve-validation.md';
const existingNotePath = '.ai-workflow/notes/implemented/process/2026-09-17-validation-delivered.md';

function proposedLinkingTo(target: string): string {
  return proposed.replace(
    'The validation gap is recorded.',
    `The validation gap is recorded in [the delivered note](${target}).`,
  );
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('notes relative Markdown link validation', () => {
  it('accepts an active note linking to an existing note', async () => {
    const project = await temporary('ai-workflow-notes-link-');
    await initializeProject(project);
    await writeFile(join(project, existingNotePath), implemented);
    const contents = proposedLinkingTo('../../implemented/process/2026-09-17-validation-delivered.md');
    await writeFile(join(project, activePath), contents);

    const result = await validateNotes(project);

    expect(result).toEqual({ valid: true, errors: [] });
    expect(await readFile(join(project, activePath), 'utf8')).toBe(contents);
  });

  it('rejects an active note whose relative Markdown link points to a missing note', async () => {
    const project = await temporary('ai-workflow-notes-link-');
    await initializeProject(project);
    const contents = proposedLinkingTo('../../implemented/process/2026-09-17-does-not-exist.md');
    await writeFile(join(project, activePath), contents);

    const result = await validateNotes(project);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(new RegExp(`${escapeForRegex(activePath)}.*(link|missing|exist)`, 'i')),
    ]));
    expect(await readFile(join(project, activePath), 'utf8')).toBe(contents);
  });

  it('does not gate outbound links from an archived note', async () => {
    const project = await temporary('ai-workflow-notes-link-');
    await initializeProject(project);
    const archivedPath = '.ai-workflow/notes/archived/process/2026-09-17-archived-decision.md';
    const archivedNote = `# Agent Note: archived-decision

Status: implemented
Archived: 2026-09-17

## Problem

The delivered decision links to [a note removed after sealing](../../implemented/process/2026-09-17-now-removed.md).

## Decision

Keep the sealed decision as entered.

## Alternatives considered

Deleting the record was declined because it still explains ownership.

## Consequences

The historical outbound link stays stale.
`;
    await writeFile(join(project, archivedPath), archivedNote);
    const digest = createHash('sha256').update(archivedNote).digest('hex');
    await writeFile(join(project, '.ai-workflow/notes/archived/manifest.json'), `${JSON.stringify({
      version: 1,
      files: { 'archived/process/2026-09-17-archived-decision.md': `sha256:${digest}` },
    }, null, 2)}\n`);

    const result = await validateNotes(project);

    expect(result).toEqual({ valid: true, errors: [] });
  });
});

describe('notes validation under single-source worktree materialization', () => {
  it('accepts a project whose contract and notes tree are symlinks to the same source content', async () => {
    const project = await temporary('ai-workflow-notes-symlink-');
    const source = await temporary('ai-workflow-notes-source-');
    await initializeProject(project);
    await mkdir(join(source, '.ai-workflow'), { recursive: true });
    await rename(join(project, '.ai-workflow/AGENTS.md'), join(source, '.ai-workflow/AGENTS.md'));
    await rename(join(project, '.ai-workflow/notes'), join(source, '.ai-workflow/notes'));
    await symlink(join(source, '.ai-workflow/AGENTS.md'), join(project, '.ai-workflow/AGENTS.md'));
    await symlink(join(source, '.ai-workflow/notes'), join(project, '.ai-workflow/notes'));

    expect((await lstat(join(project, '.ai-workflow/AGENTS.md'))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(project, '.ai-workflow/notes'))).isSymbolicLink()).toBe(true);

    const result = await validateNotes(project);

    expect(result).toEqual({ valid: true, errors: [] });
  });
});
