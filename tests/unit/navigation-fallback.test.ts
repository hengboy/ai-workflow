import { describe, expect, it } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { authorizeFallback } from '../../src/context/fallback.js';
import { temporary } from '../helpers.js';

describe('navigation fallback authorization', () => {
  it('authorizes a complete stale-index request only inside declared module roots', async () => {
    const project = await temporary('ai-workflow-navigation-fallback-');
    await mkdir(join(project, 'src/workflow'), { recursive: true });

    await expect(authorizeFallback(project, {
      status: 'stale', reason: 'src/workflow/parse.ts no longer contains readPlan', objective: 'Locate workflow parser',
      known_paths: ['src/workflow/parse.ts'], module_roots: ['src/workflow'], maintain_index: true, question: 'Which public parser entry replaced readPlan?'
    })).resolves.toEqual({ status: 'authorized', module_roots: ['src/workflow'] });
  });

  it.each([
    [{ status: 'miss', reason: 'not indexed', objective: 'Locate parser', known_paths: [], module_roots: [], maintain_index: false, question: 'Where is it?' }, /authorized module root/i],
    [{ status: 'missing_index', reason: 'missing', objective: 'Create index', known_paths: [], module_roots: ['.'], maintain_index: true, question: 'Which entry exists?' }, /concrete project directory/i],
    [{ status: 'hit', reason: 'indexed', objective: 'Locate parser', known_paths: [], module_roots: ['src'], maintain_index: false, question: 'Where is it?' }, /does not permit fallback/i]
  ])('blocks invalid fallback packet %#', async (packet, error) => {
    const project = await temporary('ai-workflow-navigation-fallback-');
    await mkdir(join(project, 'src'), { recursive: true });

    const result = await authorizeFallback(project, packet);

    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') expect(result.reason).toMatch(error);
  });
});
