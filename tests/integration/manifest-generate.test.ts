import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { generateManifest } from '../../src/workflow/generate.js';
import { validateWorkflow } from '../../src/workflow/validate.js';
import { frozenPlan, temporary } from '../helpers.js';

describe('v2 manifest generation', () => {
  it('generates a validated deterministic manifest and snapshots script and args', async () => {
    const project = await temporary('ai-workflow-manifest-');
    const plan = await frozenPlan(project);
    const first = await generateManifest(plan, 'codex');
    const firstScript = await readFile(join(plan, 'workflow.js'));
    const firstArgs = await readFile(join(plan, 'workflow.args.json'));
    const firstWorkflow = await readFile(join(plan, 'workflow.json'));
    const second = await generateManifest(plan, 'codex');

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect((await readFile(join(plan, 'workflow.js'))).equals(firstScript)).toBe(true);
    expect((await readFile(join(plan, 'workflow.args.json'))).equals(firstArgs)).toBe(true);
    expect((await readFile(join(plan, 'workflow.json'))).equals(firstWorkflow)).toBe(true);
    expect(first.schema_version).toBe('2.0.0');
    expect(JSON.parse(firstWorkflow)).not.toHaveProperty('nodes');
    expect(first.actions.length).toBeGreaterThan(0);
    expect(first.input_artifacts_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((await validateWorkflow(first, resolve(plan, '../../..'))).valid).toBe(true);
  });
});
