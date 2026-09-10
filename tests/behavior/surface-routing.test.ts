import { describe, expect, it } from 'vitest';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readTasks } from '../../src/workflow/parse.js';
import { renderMarkdown } from '../../src/utils/frontmatter.js';
import { packagePath } from '../../src/utils/schema.js';
import { frozenPlan, temporary } from '../helpers.js';

const exec = promisify(execFile);
const supportedSurfaces = ['backend', 'frontend', 'cross-stack', 'test', 'docs', 'research', 'documentation'];

function taskAttributes(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'task-001-example',
    requirements: ['REQ-001'],
    acceptance_criteria: ['AC-001'],
    depends_on: [],
    feature: 'task-input',
    locator_read_order: ['src/input.ts'],
    read_scope: [
      'MEMORY.md',
      '.ai-workflow/index/navigation.json',
      '.ai-workflow/index/navigation.md',
      'src/input.ts',
    ],
    write_scope: ['src/output.ts'],
    test_commands: ['pnpm test'],
    ...overrides,
  };
}

async function writeTaskFile(plan: string, attributes: Record<string, unknown>): Promise<void> {
  await writeFile(join(plan, 'tasks', 'task-001-example.md'), renderMarkdown(attributes, '# Task'));
}

describe('task surface routing', () => {
  it.each(supportedSurfaces)('accepts the supported %s surface', async (surface) => {
    const root = await temporary();
    const plan = await frozenPlan(root);
    await writeTaskFile(plan, taskAttributes({ surface }));

    const tasks = await readTasks(plan);

    expect(tasks[0]?.surface).toBe(surface);
  });

  it('rejects a task with an empty or missing surface before execution', async () => {
    const root = await temporary();
    const plan = await frozenPlan(root);

    await writeTaskFile(plan, taskAttributes());
    await expect(readTasks(plan)).rejects.toThrow(/surface/i);

    await writeTaskFile(plan, taskAttributes({ surface: '' }));
    await expect(readTasks(plan)).rejects.toThrow(/surface/i);
  });

  it('rejects an unknown surface with a diagnostic naming surface and allowed values', async () => {
    const root = await temporary();
    const plan = await frozenPlan(root);
    await writeTaskFile(plan, taskAttributes({ surface: 'mobile-ios' }));

    let message = '';
    try {
      await readTasks(plan);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/surface/i);
    expect(message).toMatch(/allowed surfaces/i);
    for (const allowed of ['backend', 'frontend', 'cross-stack', 'research', 'documentation']) {
      expect(message).toContain(allowed);
    }
  });

  it('documents the surface routing table in the coding skill', async () => {
    const coding = (await readFile(packagePath('templates', 'skills', 'coding', 'SKILL.md'), 'utf8')).replace(/\s+/g, ' ');
    const route = (surface: string, role: string): RegExp =>
      new RegExp(`\`?${surface}\`?\\s*(?:→|->|\\|)\\s*${role}`, 'i');

    expect(coding).toMatch(/## Surface routing/i);
    expect(coding).toMatch(route('backend', 'Backend Developer'));
    expect(coding).toMatch(route('frontend', 'Frontend Developer'));
    expect(coding).toMatch(route('research', 'Researcher'));
    expect(coding).toMatch(route('documentation', 'Documentation Maintainer'));
    expect(coding).toMatch(
      /`?cross-stack`?\s*(?:→|->|\|)\s*Backend Developer\b[^.]{0,80}?\bthen\b[^.]{0,80}?Frontend Developer/i,
    );
    expect(coding).toMatch(/cross-stack[^.]{0,120}?dependency order/i);
    expect(coding).toMatch(/empty or unknown[^.]{0,40}?surface[^.]{0,40}?(?:fail|reject)[^.]{0,40}?before execution/i);
  });

  it('fails plan validate before execution when a task surface is invalid', async () => {
    const root = await temporary();
    const plan = await frozenPlan(root);
    await writeTaskFile(plan, taskAttributes({ surface: 'mobile-ios' }));

    await expect(exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'plan', 'validate', '--plan', plan])).rejects.toThrow(/allowed surfaces/i);
  });

  it('validates a plan whose task surface is supported', async () => {
    const root = await temporary();
    const plan = await frozenPlan(root);
    await writeTaskFile(plan, taskAttributes({ surface: 'backend' }));

    const { stdout } = await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'plan', 'validate', '--plan', plan]);

    expect(stdout).toContain('"valid": true');
  });

  it('does not expose the removed role in schemas or generated declarations', async () => {
    for (const directory of [packagePath('schemas'), packagePath('src', 'generated')]) {
      for (const entry of await readdir(directory)) {
        const path = join(directory, entry);
        const text = await readFile(path, 'utf8');
        expect(text, path).not.toMatch(/task[- _]?worker/i);
      }
    }
  });

  it('preserves the one-repair gate in implementation and test roles', async () => {
    const backend = await readFile(packagePath('templates', 'agents', 'backend.md'), 'utf8');
    const frontend = await readFile(packagePath('templates', 'agents', 'frontend.md'), 'utf8');
    const test = await readFile(packagePath('templates', 'agents', 'test.md'), 'utf8');

    expect(backend).toMatch(/one repair round is available/i);
    expect(frontend).toMatch(/one repair round/i);
    expect(test).toMatch(/one developer repair round/i);
  });

  it('rejects a task with a project-root read scope', async () => {
    const root = await temporary();
    const plan = await frozenPlan(root);
    await writeTaskFile(plan, taskAttributes({ surface: 'backend', read_scope: ['.'] }));

    await expect(readTasks(plan)).rejects.toThrow(/Invalid task scope/i);
  });
});
