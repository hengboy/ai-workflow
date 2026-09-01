import { describe, expect, it } from 'vitest';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { authorizeFallback } from '../../src/context/fallback.js';
import { temporary } from '../helpers.js';

function packet(overrides: Record<string, unknown> = {}) {
  return {
    status: 'stale' as const,
    target: { feature: 'workflow-parsing' },
    reason: 'src/workflow/parse.ts no longer contains readPlan',
    known_paths: ['src/workflow/parse.ts'],
    known_symbols: ['src/workflow/parse.ts#readPlan'],
    module_roots: ['src/workflow'],
    maintenance_authorized: true,
    question: 'Which public parser entry replaced readPlan?',
    ...overrides
  };
}

describe('navigation fallback authorization', () => {
  it('authorizes a complete stale-index request only inside declared module roots', async () => {
    const project = await temporary('ai-workflow-navigation-fallback-');
    await mkdir(join(project, 'src/workflow'), { recursive: true });
    await writeFile(join(project, 'src/workflow/parse.ts'), 'export function parsePlan(): void {}\n');

    await expect(authorizeFallback(project, packet())).resolves.toEqual({ status: 'authorized', module_roots: ['src/workflow'] });
  });

  it.each([
    [packet({ module_roots: [] }), /authorized module root/i],
    [packet({ module_roots: ['.'] }), /concrete project directory/i],
    [packet({ target: {} }), /one target/i],
    [packet({ known_paths: ['src/'] }), /exact known file path/i]
  ])('blocks incomplete or broad fallback packet %#', async (value, error) => {
    const project = await temporary('ai-workflow-navigation-fallback-');
    await mkdir(join(project, 'src/workflow'), { recursive: true });

    const result = await authorizeFallback(project, value);

    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') expect(result.reason).toMatch(error);
  });

  it('blocks a module-root symlink that resolves outside the project', async () => {
    const project = await temporary('ai-workflow-navigation-fallback-');
    const outside = await temporary('ai-workflow-navigation-outside-');
    await mkdir(join(project, 'src'), { recursive: true });
    await symlink(outside, join(project, 'src/workflow'));

    const result = await authorizeFallback(project, packet());

    expect(result).toEqual({ status: 'blocked', reason: 'src/workflow: expected a concrete project directory' });
  });
});
