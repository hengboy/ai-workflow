import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { packagePath } from '../../src/utils/schema.js';

const normalize = (text: string): string => text.replace(/\s+/g, ' ');

describe('mandatory project-local temporary worktree policy', () => {
  it('records the mandatory project-local temporary worktree standard in MEMORY.md', async () => {
    const memory = normalize(await readFile(packagePath('MEMORY.md'), 'utf8'));

    expect(memory).toContain('project-local temporary worktree');
    expect(memory).toContain('.worktrees');
    expect(memory).toContain('ai-workflow adr list');
    expect(memory).toContain('<project>/.worktrees/<name>');
    expect(memory).toMatch(/before implementation/i);
    expect(memory).not.toMatch(/consider\b[^.]*worktree|worktree[^.]*optional/i);
  });

  it('states the mandatory project-local temporary worktree policy in AGENTS.md and CLAUDE.md', async () => {
    for (const path of ['AGENTS.md', 'CLAUDE.md']) {
      const text = normalize(await readFile(packagePath(path), 'utf8'));
      expect(text).toMatch(/project-local temporary worktree/i);
      expect(text).toContain('<project>/.worktrees/<name>');
      expect(text).toMatch(/before implementation/i);
      expect(text).not.toMatch(/consider\b[^.]*worktree|worktree[^.]*optional/i);
    }
  });
});
