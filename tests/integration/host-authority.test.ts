import { describe, expect, it } from 'vitest';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateManifest } from '../../src/workflow/generate.js';
import { ManifestHostAuthority } from '../../src/runtime/host-authority.js';
import { sha256 } from '../../src/utils/hash.js';
import { frozenPlan, temporary } from '../helpers.js';

describe('manifest host authority', () => {
  it('rejects a targeted recheck whose evidence digest list does not match its evidence paths', async () => {
    const project = await temporary('ai-workflow-host-authority-');
    const bin = await temporary('ai-workflow-host-authority-bin-');
    const plan = await frozenPlan(project);
    const manifest = await generateManifest(plan, 'codex');
    const findingId = `finding-sha256:${'a'.repeat(64)}`;
    const source = sha256('source review');
    const repair = sha256('repair diff');
    const host = join(bin, 'codex');
    await writeFile(host, `#!/usr/bin/env node
const { readFileSync } = require('node:fs');
const input = readFileSync(0, 'utf8');
const packet = JSON.parse(input.split('PACKET:\\n')[1].split('\\n\\nRespond')[0]);
process.stdout.write(JSON.stringify({ result_version: '2.0.0', status: 'done', summary: 'recheck', changed_paths: [], evidence: [], tests: [], findings: [], git_refs: [], support_requests: [], value: { result_version: '2.0.0', result_type: 'finding-recheck', finding_id: ${JSON.stringify(findingId)}, status: 'closed', evidence_paths: ['src/input.ts'], evidence_digests: [${JSON.stringify(sha256(await readFile(join(project, 'src/input.ts'))))}, ${JSON.stringify(sha256('extra digest'))}], repair_diff_digest: ${JSON.stringify(repair)}, source_review_receipt_digest: ${JSON.stringify(source)}, message: packet.objective } }));
`);
    await chmod(host, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath ?? ''}`;
    try {
      const authority = new ManifestHostAuthority({ project, runId: 'run-authority', manifest });

      await expect(authority.recheck('standards-review', findingId, project, source, repair)).rejects.toMatchObject({ code: 'AUTHORITY_INVALID' });
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it('rejects a repair test result that omits the manifest-authorized test command', async () => {
    const project = await temporary('ai-workflow-host-authority-');
    const bin = await temporary('ai-workflow-host-authority-bin-');
    const plan = await frozenPlan(project);
    const manifest = await generateManifest(plan, 'codex');
    const host = join(bin, 'codex');
    await writeFile(host, `#!/usr/bin/env node
const { readFileSync } = require('node:fs');
readFileSync(0, 'utf8');
process.stdout.write(JSON.stringify({ result_version: '2.0.0', status: 'done', summary: 'repair test', changed_paths: [], evidence: [], tests: [], findings: [], git_refs: [], support_requests: [], value: { result_version: '2.0.0', result_type: 'repair-test', task_id: 'task-001-example', tests: [] } }));
`);
    await chmod(host, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath ?? ''}`;
    try {
      const authority = new ManifestHostAuthority({ project, runId: 'run-authority', manifest });

      await expect(authority.repairTest(project, 'task-001-example')).rejects.toMatchObject({ code: 'AUTHORITY_INVALID' });
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it('rejects a review finding outside manifest action scope', async () => {
    const project = await temporary('ai-workflow-host-authority-');
    const bin = await temporary('ai-workflow-host-authority-bin-');
    const plan = await frozenPlan(project);
    const manifest = await generateManifest(plan, 'codex');
    const host = join(bin, 'codex');
    await writeFile(host, `#!/usr/bin/env node
const { readFileSync } = require('node:fs');
readFileSync(0, 'utf8');
process.stdout.write(JSON.stringify({ result_version: '2.0.0', status: 'done', summary: 'review', changed_paths: [], evidence: [], tests: [], findings: [], git_refs: [], support_requests: [], value: { result_version: '2.0.0', result_type: 'review', gate_id: 'standards-review', findings: [{ severity: 'error', message: 'out of scope', path: 'secret.txt', applicable_action_ids: ['unknown-action'] }] } }));
`);
    await chmod(host, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath ?? ''}`;
    try {
      const authority = new ManifestHostAuthority({ project, runId: 'run-authority', manifest });

      await expect(authority.review('standards-review', project)).rejects.toMatchObject({ code: 'AUTHORITY_SCOPE_INVALID' });
    } finally {
      process.env.PATH = previousPath;
    }
  });
});
