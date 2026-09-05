import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import AjvModule, { type AnySchema, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';

const root = join(import.meta.dirname, '..', '..');
const schemaDir = join(root, 'schemas');
const generatedDir = join(root, 'src', 'generated');
const digest = 'sha256:' + 'a'.repeat(64);
type JsonSchema = Record<string, unknown>;

async function validators(): Promise<Map<string, ValidateFunction>> {
  const Ajv = AjvModule as unknown as new (options: object) => import('ajv').default;
  const addFormats = addFormatsModule as unknown as (ajv: import('ajv').default) => void;
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  const names = [
    'call-checkpoint.schema.json',
    'coding-agent-result.schema.json',
    'coding-event.schema.json',
    'coding-manifest.schema.json',
    'coding-protocol.schema.json',
    'coding-resource.schema.json',
    'coding-run.schema.json',
    'coding-sandbox.schema.json',
    'receipt.schema.json',
    'result.schema.json',
    'review-repair-resolution.schema.json',
    'workflow-script-meta.schema.json',
    'workflow-v2.schema.json',
  ];
  const schemas = await Promise.all(names.map(async (name) => [name, JSON.parse(await readFile(join(schemaDir, name), 'utf8')) as JsonSchema] as const));
  for (const [name, schema] of schemas) {
    const alias: JsonSchema = { ...schema };
    delete alias.$id;
    ajv.addSchema(alias as AnySchema, `schemas/${name}`);
    ajv.addSchema({ ...alias } as AnySchema, `schemas/schemas/${name}`);
  }
  return new Map(names.map((name) => {
    return [name, ajv.getSchema(`schemas/${name}`)!] as const;
  }));
}

const validManifest = {
  schema_version: '2.0.0',
  engine: 'worker-thread-trusted',
  plan_id: '20260903-contracts',
  host: 'codex',
  project: { git_common_dir_digest: digest, target_branch: 'main' },
  input_artifacts: [{ path: 'spec.md', kind: 'spec', bytes_digest: digest }],
  input_artifacts_digest: digest,
  script: { path: 'workflow.js', bytes_digest: digest, meta_digest: digest, language: 'javascript' },
  meta: { name: 'contracts', description: 'contract test workflow' },
  args: { path: 'workflow.args.json', bytes_digest: digest },
  concurrency_groups: [],
  limits: { max_concurrent_agents: 3, max_total_agents: 256, max_items_per_call: 256, max_script_bytes: 262144, max_result_bytes: 1048576, sync_timeout_ms: 5000, dispose_grace_ms: 5000 },
  policies: { max_retries: 2, repair_rounds: 1, push_allowed: false, rebase_allowed: false, mixed_host_allowed: false, untrusted_script_allowed: false },
  host_execution: {
    adapter: 'codex',
    mode: 'brokered-sandbox',
    model_transport: { owner: 'host-native-broker', network_allowed: true, project_write_allowed: false, credential_visibility: 'broker-only' },
    action_executor: { process_group: true, network_allowed: false, project_write_enforced: true, git_metadata_write_allowed: false },
    native_tool_authorization: 'audited',
    capability_digest: digest,
  },
  tasks: [{ task_id: 'task-001-main', requirements: ['requirement'], acceptance_criteria: ['criterion'], feature: 'feature', activation: 'required', depends_on: [], required_actions: ['task-001-explore'], optional_actions: [], finalization_action: 'task-001-finalize', finalization_mode: 'commit-and-merge', worktree_policy: 'isolated-task-worktree', max_repair_rounds: 1 }],
  actions: [{ action_id: 'task-001-explore', task_id: 'task-001-main', operation: 'explore', role: 'backend', locator_read_order: ['src'], read_scope: ['src'], write_scope: [], new_module_directories: [], allowed_commands: [], test_commands: [], requires_actions: [], max_attempts: 1, optional: false, write_access: false, host_only: false }],
  scope_conflicts: [],
  aggregate_repair: { action_id: 'plan-aggregate-repair', task_id: 'plan', operation: 'repair', role: 'backend', locator_read_order: [], read_scope: [], write_scope: [], new_module_directories: [], allowed_commands: [], test_commands: [], output_schema: 'schemas/coding-agent-result.schema.json', requires_actions: [], max_attempts: 1, optional: false, write_access: true, host_only: true, maximum_write_scope: [], test_actions_by_task: {}, worktree_policy: 'isolated-repair-worktree' },
  repair_tests: [],
  review_rechecks: [],
  mandatory_gates: [],
};

const validResult = {
  result_version: '2.0.0',
  status: 'done',
  summary: 'ok',
  changed_paths: [],
  evidence: [],
  tests: [],
  findings: [],
  git_refs: [],
  support_requests: [],
};

describe('v2 machine contracts', () => {
  it('accepts a complete manifest and rejects unknown fields', async () => {
    const validate = (await validators()).get('coding-manifest.schema.json')!;
    expect(validate(validManifest)).toBe(true);
    expect(validate({ ...validManifest, unknown: true })).toBe(false);
  });

  it('rejects duplicate manifest entries and non-canonical paths', async () => {
    const validate = (await validators()).get('coding-manifest.schema.json')!;
    expect(validate({ ...validManifest, actions: [validManifest.actions[0], validManifest.actions[0]] })).toBe(false);
    expect(validate({ ...validManifest, script: { ...validManifest.script, path: '../workflow.js' } })).toBe(false);
    expect(validate({ ...validManifest, schema_version: '1.0.0' })).toBe(false);
  });

  it('rejects illegal run states and v2 adjustments', async () => {
    const runValidate = (await validators()).get('coding-run.schema.json')!;
    expect(runValidate({ record_version: '2.0.0', engine: 'worker-thread-trusted', run_id: 'run-1', manifest_digest: digest, fencing_epoch: 1, run_state: 'failed', parent_run: 'root', started_at: '2026-09-03T00:00:00.000Z', updated_at: '2026-09-03T00:00:00.000Z', call_ledger: [], control_ledger: [], resources: [] })).toBe(false);
    const adjustment = JSON.parse(await readFile(join(schemaDir, 'adjustment.schema.json'), 'utf8')) as JsonSchema;
    const Ajv = AjvModule as unknown as new (options: object) => import('ajv').default;
    const ajv = new Ajv({ strict: true });
    const validateAdjustment = ajv.compile(adjustment as AnySchema);
    expect(validateAdjustment({ version: '2.0.0', operations: [] })).toBe(false);
  });

  it('rejects illegal protocol and event discriminators', async () => {
    const protocol = (await validators()).get('coding-protocol.schema.json')!;
    expect(protocol({ type: 'unknown', protocol_version: '2.0.0', run_id: 'run-1', message_id: 1 })).toBe(false);
    expect(protocol({ type: 'ready', protocol_version: '1.0.0', run_id: 'run-1', message_id: 1 })).toBe(false);
    const event = (await validators()).get('coding-event.schema.json')!;
    expect(event({ event_version: '2.0.0', seq: 1, at: '2026-09-03T00:00:00.000Z', run_id: 'run-1', fencing_epoch: 1, type: 'unknown', payload: {} })).toBe(false);
  });

  it('requires host-generated finding identity for persisted review results', async () => {
    const event = (await validators()).get('coding-event.schema.json')!;
    expect(event({ event_version: '2.0.0', seq: 1, at: '2026-09-03T00:00:00.000Z', run_id: 'run-1', fencing_epoch: 1, type: 'review/result', payload: { findings: [{ ordinal: 1, source_gate: 'standards-review', severity: 'error', message: 'bad', message_digest: digest, applicable_action_ids: [] }] } })).toBe(false);
    const result = (await validators()).get('coding-agent-result.schema.json')!;
    expect(result(validResult)).toBe(true);
  });

  it('keeps generated declarations synchronized with v2 schemas', async () => {
    const schemaNames = (await readdir(schemaDir)).filter((name) => name.endsWith('.schema.json')).sort();
    const generatedNames = (await readdir(generatedDir)).filter((name) => name.endsWith('.schema.d.ts')).sort();
    expect(generatedNames).toEqual(schemaNames.map((name) => name.replace(/\.json$/, '.d.ts')));
    const generated = await Promise.all(['coding-event.schema.d.ts', 'coding-protocol.schema.d.ts', 'coding-manifest.schema.d.ts', 'receipt.schema.d.ts', 'coding-run.schema.d.ts'].map((name) => readFile(join(generatedDir, name), 'utf8')));
    expect(generated[0]).toContain('CodingEventType');
    expect(generated[1]).toContain('CallDescriptor');
    expect(generated[2]).toContain('CodingActionCapability');
    expect(generated[3]).toContain('ApprovalReceiptV2');
    expect(generated[4]).toContain('RunStateV2');
  });
});
