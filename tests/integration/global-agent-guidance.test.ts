import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { packagePath } from '../../src/utils/schema.js';

describe('global agent guidance', () => {
  it('keeps the root instructions authoritative for routing and boundaries', async () => {
    const agents = await readFile(packagePath('AGENTS.md'), 'utf8');
    const claude = await readFile(packagePath('CLAUDE.md'), 'utf8');
    const required = ['Planning', 'Plan-to-tasks', 'Coding', 'Backend', 'Frontend', 'Test', 'File Explorer', 'Researcher', 'Documentation Maintainer', 'Spec Review', 'Standards Review', 'Git Operator', 'Task Worker'];
    for (const role of required) {
      expect(agents).toContain(role);
      expect(claude).toContain(role);
    }
    expect(agents).toContain('authoritative for every sub-agent');
    expect(agents).toContain('Git Operator is the only role allowed to run Git');
    expect(agents).toContain('Navigation JSON is authoritative');
    expect(agents).toContain('same change');
    expect(agents).toContain('immediate');
  });

  it('ships the same canonical contract in initialized projects', async () => {
    const agents = await readFile(packagePath('templates', 'project', 'AGENTS.md'), 'utf8');
    const claude = await readFile(packagePath('templates', 'project', 'CLAUDE.md'), 'utf8');
    expect(agents).toContain('Documentation Maintainer');
    expect(agents).toContain('same change');
    expect(claude).toContain('complete shared sub-agent contract');
    expect(claude).toContain('Spec Review');
    expect(agents).toContain('TDD');
    expect(claude).toContain('TDD');
  });
});
