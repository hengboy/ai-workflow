import { describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initializeProject } from '../../src/install/index.js';
import { validateNotes } from '../../src/notes/validate.js';
import { temporary } from '../helpers.js';

describe('notes format validation', () => {
  it.each([
    {
      name: 'rejects a proposed note whose status belongs to another lifecycle',
      path: '.ai-workflow/notes/proposed/feature/2026-09-17-status-mismatch.md',
      contents: `# Agent Note: status-mismatch

Status: implemented

## Problem

The problem is recorded.

## Proposal

The proposal is recorded.

## Alternatives considered

The alternative and its reason are recorded.

## Acceptance criteria

The acceptance criteria are recorded.

## Risks

The risks are recorded.
`,
      expectedReason: /status.*proposed|proposed.*status|lifecycle/i,
    },
  ])('$name', async ({ path, contents, expectedReason }) => {
    const project = await temporary('ai-workflow-notes-format-');
    await initializeProject(project);
    await writeFile(join(project, path), contents);

    const result = await validateNotes(project);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))),
    ]));
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(expectedReason),
    ]));
  });
});
