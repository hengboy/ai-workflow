import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { packagePath } from '../../src/utils/schema.js';

const normalize = (text: string): string => text.replace(/\s+/g, ' ');

describe('mandatory project-local temporary worktree policy', () => {
  it('records the mandatory project-local temporary worktree standard in the project contract', async () => {
    // REQ-004/AC-004: the worktree standard's owner moves from MEMORY.md to the contract.
    const contract = normalize(await readFile(packagePath('.ai-workflow/AGENTS.md'), 'utf8'));

    expect(contract).toContain('project-local temporary worktree');
    expect(contract).toContain('.worktrees');
    expect(contract).toContain('<project>/.worktrees/<name>');
    expect(contract).toMatch(/before implementation/i);
    expect(contract).not.toMatch(/consider\b[^.]*worktree|worktree[^.]*optional/i);
    // REQ-004 / REQ-008: current standards point at notes governance, not the retired ADR command.
    expect(contract).toMatch(/\.ai-workflow\/notes\//);
    expect(contract).not.toMatch(/ai-workflow\s+adr\b/i);
  });

  it('no longer restates the worktree-materialization standard in MEMORY.md', async () => {
    const memory = normalize(await readFile(packagePath('MEMORY.md'), 'utf8'));

    expect(memory, 'REQ-004/AC-004: MEMORY no longer owns the worktree standard').not.toContain(
      'project-local temporary worktree',
    );
    expect(memory, 'REQ-004/AC-004: MEMORY no longer carries the worktree path standard').not.toContain(
      '<project>/.worktrees/<name>',
    );
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

    // REQ-004/AC-004: the worktree materialization standard is owned by the contract, not MEMORY.
    for (const path of ['.ai-workflow/AGENTS.md', 'templates/project/AGENTS.md']) {
      const text = normalize(await readFile(packagePath(path), 'utf8'));
      expect(text, `${path} shares ignored state`).toMatch(/gitignored state/i);
      expect(text, `${path} excludes the worktree container`).toContain('.worktrees/');
    }
  });

  it('materializes notes alongside the project contract as a single source in the generated contract', async () => {
    const contract = normalize(await readFile(packagePath('templates/project/AGENTS.md'), 'utf8'));
    const materialization = contract.split(/(?<=\.)\s/).find((sentence) => /gitignored state/i.test(sentence));

    expect(materialization, 'templates/project/AGENTS.md states the worktree materialization standard').toBeDefined();
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
    expect(coding, 'workspace rules are loaded before preparation or implementation state').toMatch(
      /Explicitly read `references\/workspace\.md` before approved preparation or any implementation state/i,
    );
    const reference = await readFile(packagePath('templates', 'skills', 'coding', 'references', 'workspace.md'), 'utf8');
    const packet = reference.match(/## Packet contract[\s\S]*?(?=\n## |$)/)?.[0] ?? '';

    expect(normalize(packet), 'every command carries an explicit workdir').toMatch(/every command uses an explicit workdir/i);
  });
});

// Behavior boundary: new worktree integration policy (REQ-002, REQ-003).
describe('direct and mechanical execution unit keeps the worktree and merges back', () => {
  it('states the mandatory worktree, in-worktree implement/validate/commit and merge-back', async () => {
    for (const path of ['templates/project/AGENTS.md', 'templates/skills/coding/SKILL.md']) {
      const text = normalize(await readFile(packagePath(path), 'utf8'));
      expect(text, `${path} makes the worktree mandatory for Direct and Mechanical`).toMatch(
        /(?:Direct|Mechanical)[^.]{0,260}mandatory[^.]{0,120}project-local temporary worktree|mandatory[^.]{0,120}project-local temporary worktree/i,
      );
      expect(text, `${path} requires implement, validate and commit inside the worktree`).toMatch(
        /implement[^.]{0,80}validat[^.]{0,80}commit/i,
      );
      expect(text, `${path} merges back into the recorded target branch`).toMatch(
        /merge[^.]{0,120}recorded target branch/i,
      );
      expect(text, `${path} skips only Planning artifacts and the dual-axis review`).toMatch(
        /(?:only|skip)[^.]{0,120}(?:Planning artifacts|dual-axis review)/i,
      );
    }
  });
});

describe('recorded integration target and merge-back', () => {
  it('records the branch and starting commit and merges with non-fast-forward', async () => {
    const operator = normalize(await readFile(packagePath('templates', 'agents', 'git-operator.md'), 'utf8'));
    const contract = normalize(await readFile(packagePath('templates/project/AGENTS.md'), 'utf8'));
    for (const text of [operator, contract]) {
      expect(text, 'records the checked-out branch at worktree creation').toMatch(
        /record[^.]{0,120}(?:checked-out branch|branch checked out)/i,
      );
      expect(text, 'records the starting commit at worktree creation').toMatch(
        /record[^.]{0,120}(?:starting commit)/i,
      );
      expect(text, 'merges the worktree branch into the recorded target branch').toMatch(
        /merge[^.]{0,120}worktree branch[^.]{0,120}recorded target branch/i,
      );
      expect(text, 'uses a non-fast-forward merge').toMatch(/non-fast-forward/i);
    }
    expect(operator, 'a target-branch advance is not source drift').toMatch(
      /target(?:-branch)? (?:advance|advanced)[^.]{0,120}not source drift/i,
    );
    expect(operator, 'source HEAD, repository and worktree identity must still match').toMatch(
      /source HEAD[^.]{0,120}(?:repository|worktree)[^.]{0,120}(?:must|still) match|identity[^.]{0,120}must (?:still )?match/i,
    );
    expect(operator, 'a detached starting checkout stops before implementation').toMatch(
      /detached[^.]{0,120}(?:stop|stops|no target branch)[^.]{0,120}(?:before implementation|implementation)/i,
    );
  });
});

describe('both-side conflict resolution', () => {
  it('preserves both sides, reruns affected checks, and blocks on failure', async () => {
    const operator = normalize(await readFile(packagePath('templates', 'agents', 'git-operator.md'), 'utf8'));
    expect(operator, 'every conflicted hunk preserves both sides').toMatch(
      /(?:every |all )?conflict(?:ed)? hunk[^.]{0,120}preserv[^.]{0,80}both sides/i,
    );
    expect(operator, 'never chooses one side wholesale').toMatch(
      /never[^.]{0,120}(?:ours|theirs)[^.]{0,80}(?:wholesale|choose)/i,
    );
    expect(operator, 'never rebases, forces, resets or amends').toMatch(
      /never[^.]{0,160}(?:rebase|force|reset|amend)/i,
    );
    expect(operator, 'affected checks rerun').toMatch(/affected checks[^.]{0,80}rerun/i);
    expect(operator, 'unresolvable or failed check aborts only the in-progress merge').toMatch(
      /abort[^.]{0,80}(?:in-progress merge|merge in progress)/i,
    );
    expect(operator, 'retains the owned worktree and branch').toMatch(
      /retain[^.]{0,80}(?:owned worktree|worktree and branch)/i,
    );
    expect(operator, 'reports blocked with conflicted paths, resolution evidence and failing check').toMatch(
      /blocked[^.]{0,160}(?:conflicted paths|resolution evidence|failing check)/i,
    );
    expect(operator, 'delivery merge SHA recorded separately').toMatch(
      /delivery merge SHA[^.]{0,80}(?:recorded separately|separate)/i,
    );
  });

  it('no reviewed authority retains the old stop-on-conflict instruction', async () => {
    const files = [
      'templates/project/AGENTS.md',
      '.ai-workflow/AGENTS.md',
      'templates/skills/coding/SKILL.md',
      'templates/skills/coding/references/workspace.md',
      'templates/skills/planning/SKILL.md',
      'templates/agents/git-operator.md',
      'README.md',
    ];
    for (const path of files) {
      const text = await readFile(packagePath(path), 'utf8');
      expect(text, `${path} drops the old no-auto-resolve instruction`).not.toContain(
        'On conflict or drift, stop with evidence; do not rebase or auto-resolve.',
      );
    }
  });

  it('keeps the tracked mirror byte-identical to the template', async () => {
    const a = await readFile(packagePath('templates/project/AGENTS.md'));
    const b = await readFile(packagePath('.ai-workflow/AGENTS.md'));
    expect(b.equals(a)).toBe(true);
  });
});
