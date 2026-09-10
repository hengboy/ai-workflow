import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { packagePath } from '../../src/utils/schema.js';

describe('global agent guidance', () => {
  it('keeps the root instructions authoritative for routing and boundaries', async () => {
    const agents = await readFile(packagePath('AGENTS.md'), 'utf8');
    const claude = await readFile(packagePath('CLAUDE.md'), 'utf8');
    const required = ['Planning', 'Plan-to-tasks', 'Coding', 'Backend', 'Frontend', 'Test', 'File Explorer', 'Researcher', 'Documentation Maintainer', 'Spec Review', 'Standards Review', 'Git Operator'];
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
    for (const text of [agents, claude]) {
      expect(text).toMatch(/Documentation Maintainer[\s\S]*?returns?\s+exact\s+changed\s+paths[\s\S]*?primary orchestrator/i);
      expect(text).not.toMatch(/Documentation Maintainer[\s\S]*?delegates?\s+the\s+local\s+commit\s+to\s+Git\s+Operator|Documentation Maintainer[\s\S]*?call\s+Git\s+Operator/i);
    }
  });

  it('requires the primary orchestrator to directly dispatch Git Operator and forbids specialist Task Worker delegation', async () => {
    const agents = await readFile(packagePath('AGENTS.md'), 'utf8');
    const claude = await readFile(packagePath('CLAUDE.md'), 'utf8');
    for (const text of [agents, claude]) {
      // REQ-002 / AC-003: the primary orchestrator directly dispatches Git Operator.
      expect(text).toMatch(/directly\s+dispatch(?:es|ing)?\s+Git\s+Operator|primary orchestrator\s+directly\s+dispatches\s+Git\s+Operator/i);
      // REQ-002: no specialist (or Task Worker) is described as dispatching children.
      expect(text).not.toMatch(/Task\s+Worker\s+(?:coordinates|delegates)|delegates\s+(?:implementation|work)\s+and\s+Git/i);
      // REQ-002 / AC-003: the maintainer returns exact paths to the primary orchestrator, never calling Git Operator.
      expect(text).toMatch(/Documentation Maintainer[\s\S]*?returns?\s+exact\s+changed\s+paths[\s\S]*?primary orchestrator/i);
      expect(text).not.toMatch(/Documentation Maintainer[\s\S]*?delegates?\s+the\s+local\s+commit\s+to\s+Git\s+Operator|Documentation Maintainer[\s\S]*?call\s+Git\s+Operator/i);
    }
  });
});
