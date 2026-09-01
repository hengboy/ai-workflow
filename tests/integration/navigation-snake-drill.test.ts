import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { frozenPlan, temporary } from '../helpers.js';

const exec = promisify(execFile);

describe('Snake read-only navigation drill', () => {
  it('reads a known frozen spec and plan directly, then blocks missing-index discovery without roots', async () => {
    const project = await temporary('ai-workflow-snake-drill-');
    const plan = await frozenPlan(project, false);

    const validated = await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'plan', 'validate', '--plan', plan]);
    const located = await exec('pnpm', ['exec', 'tsx', 'src/cli.ts', 'context', 'locate', '--project', project, '--feature', 'snake-known-plan']);

    expect(JSON.parse(validated.stdout)).toMatchObject({ valid: true, plan_id: '20260831-example' });
    expect(JSON.parse(located.stdout)).toMatchObject({
      status: 'missing_index',
      fallback_required: true,
      fallback: { target: { feature: 'snake-known-plan' }, module_roots: [], known_paths: [], known_symbols: [] }
    });
  });
});
