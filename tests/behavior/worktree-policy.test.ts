import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { packagePath } from '../../src/utils/schema.js';

const normalize = (text: string): string => text.replace(/\s+/g, ' ');

describe('mandatory project-local temporary worktree policy', () => {
  it('records the mandatory project-local temporary worktree standard in MEMORY.md', async () => {
    const memory = normalize(await readFile(packagePath('MEMORY.md'), 'utf8'));

    expect(memory).toContain('project-local temporary worktree');
    expect(memory).toContain('.worktrees');
    expect(memory).toContain('<project>/.worktrees/<name>');
    expect(memory).toMatch(/before implementation/i);
    expect(memory).not.toMatch(/consider\b[^.]*worktree|worktree[^.]*optional/i);
    // REQ-004 / REQ-008: current standards point at notes governance, not the retired ADR command.
    expect(memory).toMatch(/\.ai-workflow\/notes\//);
    expect(memory).not.toMatch(/ai-workflow\s+adr\b/i);
  });

  it('states the mandatory project-local temporary worktree policy in the project contract', async () => {
    for (const path of ['templates/project/AGENTS.md']) {
      const text = normalize(await readFile(packagePath(path), 'utf8'));
      expect(text).toMatch(/project-local temporary worktree/i);
      expect(text).toContain('<project>/.worktrees/<name>');
      expect(text).toMatch(/before implementation/i);
      expect(text).not.toMatch(/consider\b[^.]*worktree|worktree[^.]*optional/i);
    }
  });

  it('materializes the entire project gitignored state into the coding worktree', async () => {
    const operator = normalize(await readFile(packagePath('templates', 'agents', 'git-operator.md'), 'utf8'));
    expect(operator).toContain('git ls-files --others --ignored --exclude-standard --directory');
    expect(operator).toMatch(/symlink/i);
    expect(operator).toMatch(/real directory/i);
    expect(operator).toContain('.worktrees/');

    const coding = normalize(await readFile(packagePath('templates', 'skills', 'coding', 'SKILL.md'), 'utf8'));
    expect(coding).toMatch(/materialize the project's entire gitignored state/i);
    expect(coding).toContain('.worktrees/');

    for (const path of ['MEMORY.md', 'templates/project/AGENTS.md', 'templates/project/MEMORY.md']) {
      const text = normalize(await readFile(packagePath(path), 'utf8'));
      expect(text, `${path} shares ignored state`).toMatch(/gitignored state/i);
      expect(text, `${path} excludes the worktree container`).toContain('.worktrees/');
    }
  });

  it('materializes notes alongside the project contract as a single source in the project MEMORY standard', async () => {
    const memory = normalize(await readFile(packagePath('templates/project/MEMORY.md'), 'utf8'));
    const materialization = memory.split(/(?<=\.)\s/).find((sentence) => /gitignored state/i.test(sentence));

    expect(materialization, 'templates/project/MEMORY.md states the worktree materialization standard').toBeDefined();
    expect(materialization).toMatch(/notes/i);
  });

  it('keeps a single coding worktree with serial task commits instead of isolated task worktrees', async () => {
    const operator = normalize(await readFile(packagePath('templates', 'agents', 'git-operator.md'), 'utf8'));

    expect(operator, 'Git Operator names the single coding worktree path').toContain('<project>/.worktrees/<name>');
    expect(operator, 'Git Operator keeps one coding worktree').toMatch(/\b(?:single|one)\b[^.]{0,40}worktree/i);
    expect(operator, 'task commits stay serial').toMatch(/\bserial(?:ly)?\b|one commit at a time/i);
    expect(operator, 'the isolated task worktree instruction is gone').not.toContain('Create one plan worktree and isolated task worktrees');
    expect(operator, 'the task-commit merge instruction is gone').not.toContain('Merge task commits into the plan worktree');
  });
});

describe('per-repository workspace worktree policy (REQ-002, REQ-004)', () => {
  it('requires one run-owned worktree per active repository on the plan branch with common-directory identity', async () => {
    const operator = normalize(await readFile(packagePath('templates', 'agents', 'git-operator.md'), 'utf8'));

    expect(operator, 'the per-repository worktree path is documented').toContain('<source-root>/.worktrees/<planId>');
    expect(operator, 'the per-repository branch is documented').toContain('ai-workflow/<planId>');
    expect(operator, 'each active repository owns one worktree').toMatch(/one run-owned worktree per (?:active )?repository|run-owned worktree per repository/i);
    expect(operator, 'the child common directory is verified').toMatch(/git rev-parse --git-common-dir|--git-common-dir/);
  });

  it('requires an explicit workdir for every workspace command', async () => {
    const coding = normalize(await readFile(packagePath('templates', 'skills', 'coding', 'SKILL.md'), 'utf8'));

    expect(coding, 'every command carries an explicit workdir').toMatch(/every command uses an explicit workdir/i);
  });
});
