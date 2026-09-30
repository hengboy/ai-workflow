import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { packagePath } from '../../src/utils/schema.js';

const CODING_SKILL = ['templates', 'skills', 'coding', 'SKILL.md'];
const GIT_OPERATOR = ['templates', 'agents', 'git-operator.md'];
const PROJECT_CONTRACT = ['templates', 'project', 'AGENTS.md'];

/** Read a shipped template without importing it, so a missing file is an assertion, not a crash. */
async function readShipped(parts: string[]): Promise<string | null> {
  try {
    return await readFile(packagePath(...parts), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Extract one Markdown heading section up to the next heading of the same or higher
 * level, so a level-three section nested under a level-two section is isolated.
 */
function section(text: string, heading: string, level = 2): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return '';
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s/.exec(lines[index] ?? '');
    if (match && (match[1]?.length ?? 0) <= level) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/** Whitespace-normalized text so multi-word fragments match across source wrapping. */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/** Assert every required fragment appears in the scoped text, naming the missing fragment. */
function expectFragments(haystack: string, fragments: readonly string[], scope: string): void {
  for (const fragment of fragments) {
    expect(haystack, `${scope} must contain "${fragment}"`).toContain(fragment);
  }
}

describe('coding implements a slice inside its own repository (REQ-007 / AC-014, AC-015)', () => {
  it('ships a Slice sessions section that refuses a mismatched slice before any worktree or record', async () => {
    const text = await readShipped(CODING_SKILL);
    expect(text, 'the coding skill is shipped').not.toBeNull();
    const slice = section(text ?? '', '## Slice sessions');
    expect(slice, 'the Slice sessions section exists').not.toBe('');

    expectFragments(
      flatten(slice),
      [
        'slice manifest',
        'workspace.yaml',
        'refuses',
        'does not match',
        'before creating a worktree',
        'implementation record'
      ],
      'the Slice sessions identity refusal'
    );
  });

  it('implements only the slice tasks inside that repository and reports the delivery commit', async () => {
    const slice = section((await readShipped(CODING_SKILL)) ?? '', '## Slice sessions');
    expect(slice, 'the Slice sessions section exists').not.toBe('');

    expectFragments(
      flatten(slice),
      ['implements only', 'slice tasks', 'inside that repository', 'delivery commit'],
      'the slice scope and delivery report'
    );
  });

  it('completes a slice with slice plan validate, repository notes validate and MEMORY', async () => {
    const slice = section((await readShipped(CODING_SKILL)) ?? '', '## Slice sessions');
    expect(slice, 'the Slice sessions section exists').not.toBe('');

    expectFragments(
      flatten(slice),
      ['ai-workflow plan validate', 'ai-workflow notes validate', 'MEMORY.md'],
      'the slice completion checks'
    );
  });
});

describe('workspace finalization pins delivery commits through Git Operator (REQ-009 / AC-018, AC-019)', () => {
  it('ships a Workspace finalization section that verifies completed slices and pins pointers', async () => {
    const text = await readShipped(CODING_SKILL);
    expect(text, 'the coding skill is shipped').not.toBeNull();
    const finalization = section(text ?? '', '## Workspace finalization');
    expect(finalization, 'the Workspace finalization section exists').not.toBe('');

    expectFragments(
      flatten(finalization),
      [
        'all slices are completed',
        'delivery commit',
        'read-only Git',
        'source repository',
        'workspace worktree',
        'empty submodule directories',
        'stages only',
        'pointer',
        'git update-index --cacheinfo 160000,<sha>,<path>'
      ],
      'the Workspace finalization procedure'
    );
  });

  it('ships a Workspace pointer commit section in the Git Operator agent', async () => {
    const text = await readShipped(GIT_OPERATOR);
    expect(text, 'the git-operator agent is shipped').not.toBeNull();
    const pointer = section(text ?? '', '### Workspace pointer commit', 3);
    expect(pointer, 'the Workspace pointer commit section exists').not.toBe('');

    expectFragments(
      flatten(pointer),
      [
        'workspace worktree',
        'empty submodule directories',
        'git update-index --cacheinfo 160000,<sha>,<path>',
        'git cat-file -e',
        'before',
        'stages only',
        'pointer'
      ],
      'the Workspace pointer commit section'
    );
  });
});

describe('decision records stay in their owning repository (REQ-010 / AC-020)', () => {
  it('ships a Note ownership section splitting workspace-root and child notes as plain plan-ID text', async () => {
    const text = await readShipped(CODING_SKILL);
    expect(text, 'the coding skill is shipped').not.toBeNull();
    const ownership = section(text ?? '', '## Note ownership');
    expect(ownership, 'the Note ownership section exists').not.toBe('');

    expectFragments(
      flatten(ownership),
      ['plain plan-ID text', 'never links', 'workspace root', 'decision', 'each repository', 'delivered facts', 'MEMORY.md'],
      'the Note ownership section'
    );
  });

  it('ships a Workspaces section in the project contract covering boundary, order, commands and finalization', async () => {
    const text = await readShipped(PROJECT_CONTRACT);
    expect(text, 'the project contract is shipped').not.toBeNull();
    const workspaces = section(text ?? '', '## Workspaces');
    expect(workspaces, 'the Workspaces section exists').not.toBe('');

    expectFragments(
      flatten(workspaces),
      [
        '.gitmodules',
        'submodule boundar',
        '<root>/.ai-workflow/plans/<planId>',
        'repository-level order',
        'ai-workflow workspace distribute --plan <directory>',
        'ai-workflow workspace status --plan <directory>',
        'read-only Git',
        'exception',
        'worktree confinement',
        'moving submodule checkouts after the pin is out of scope',
        'plain plan-ID text',
        'decision',
        'delivered facts',
        'finalization',
        'pointer'
      ],
      'the Workspaces section'
    );
  });
});
