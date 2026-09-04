import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CodingCapabilityManifest } from '../generated/coding-manifest.schema.js';
import type { FindingRecheckResult } from '../generated/review-repair-resolution.schema.js';
import type { AgentPacket } from '../generated/packet.schema.js';
import type { AgentResult } from '../generated/result.schema.js';
import { invokeHost } from '../adapters/process.js';
import { BrokeredSandboxProvider } from '../security/sandbox.js';
import { objectDigest, sha256 } from '../utils/hash.js';
import { schemaValidator, formatSchemaErrors } from '../utils/schema.js';
import { writeJson } from '../utils/fs.js';
import type { ReviewFindingReceipt } from './repair.js';

type ReviewGate = 'standards-review' | 'spec-review';
type ReviewFinding = { severity: 'error' | 'warning' | 'info'; message: string; path: string; applicableActionIds: string[] };
type AuthorityValue =
  | { result_version: '2.0.0'; result_type: 'plan-validation'; valid: boolean; errors: string[] }
  | { result_version: '2.0.0'; result_type: 'review'; gate_id: ReviewGate; findings: Array<{ severity: 'error' | 'warning' | 'info'; message: string; path: string; applicable_action_ids: string[] }> }
  | { result_version: '2.0.0'; result_type: 'aggregate-repair'; changed_paths: string[] }
  | { result_version: '2.0.0'; result_type: 'repair-test'; task_id: string; tests: Array<{ command: string; status: 'passed' | 'failed' | 'skipped' }> };

export class HostAuthorityError extends Error {
  readonly name = 'HostAuthorityError';
  constructor(readonly code: 'AUTHORITY_UNAVAILABLE' | 'AUTHORITY_INVALID' | 'AUTHORITY_SCOPE_INVALID', message: string) { super(message); }
}

function authorityDirectory(project: string, runId: string): string { return join(project, '.ai-workflow', 'runs', runId, 'receipts', 'authority'); }

function asValue(result: AgentResult): unknown {
  if (result.status !== 'done' || result.value === undefined) throw new HostAuthorityError('AUTHORITY_INVALID', 'host authority did not return a completed structured result');
  return result.value;
}

async function validateAuthority(value: unknown): Promise<AuthorityValue> {
  const validate = await schemaValidator('host-authority.schema.json');
  if (!validate(value)) throw new HostAuthorityError('AUTHORITY_INVALID', formatSchemaErrors(validate.errors));
  return value as AuthorityValue;
}

function packet(manifest: CodingCapabilityManifest, runId: string, role: AgentPacket['role'], objective: string, cwd: string, readPaths: string[], writePaths: string[], evidence: string[], schema: AgentPacket['result_schema']): AgentPacket {
  return { packet_version: '1.0.0', run_id: runId, plan_id: manifest.plan_id, role, objective, cwd, read_paths: readPaths, write_paths: writePaths, evidence, screenshot_dir: `.ai-workflow/plans/${manifest.plan_id}/screenshot/`, allowed_commands: [], timeout_ms: manifest.limits.sync_timeout_ms, result_schema: schema };
}

export class ManifestHostAuthority {
  constructor(private readonly options: { project: string; runId: string; manifest: CodingCapabilityManifest }) {}

  async planValidation(cwd: string): Promise<{ valid: boolean; errors: string[] }> {
    const result = await this.invoke('test', 'Host authority plan validation', cwd, [], [], []);
    const value = await validateAuthority(asValue(result));
    if (value.result_type !== 'plan-validation') throw new HostAuthorityError('AUTHORITY_INVALID', 'plan authority returned the wrong result type');
    await this.save('plan-validation.json', value);
    return value;
  }

  async review(gate: ReviewGate, cwd: string): Promise<{ findings: ReviewFinding[] }> {
    const capability = this.options.manifest.review_rechecks.find((entry) => entry.gate_id === gate);
    if (!capability || capability.role !== gate || capability.output_schema !== 'schemas/review-repair-resolution.schema.json') throw new HostAuthorityError('AUTHORITY_UNAVAILABLE', `manifest review authority is unavailable: ${gate}`);
    const result = await this.invoke(capability.role, `Host authority review ${gate}`, cwd, [...capability.read_scope], [], []);
    const value = await validateAuthority(asValue(result));
    if (value.result_type !== 'review' || value.gate_id !== gate) throw new HostAuthorityError('AUTHORITY_INVALID', `review authority returned the wrong gate: ${gate}`);
    const findings = value.findings.map((finding) => ({ severity: finding.severity, message: finding.message, path: finding.path, applicableActionIds: finding.applicable_action_ids }));
    for (const finding of findings) {
      const actions = finding.applicableActionIds.map((actionId) => this.options.manifest.actions.find((action) => action.action_id === actionId));
      if (!actions.length || actions.some((action) => !action)) throw new HostAuthorityError('AUTHORITY_SCOPE_INVALID', 'review finding references an action outside the manifest');
      if (!actions.some((action) => action!.write_scope.some((scope) => finding.path === scope || finding.path.startsWith(`${scope}/`)))) throw new HostAuthorityError('AUTHORITY_SCOPE_INVALID', 'review finding path is outside applicable manifest action scope');
    }
    await this.save(`${gate}-draft.json`, { receipt_version: '2.0.0', receipt_type: 'host-review-draft', gate_id: gate, manifest_digest: objectDigest(this.options.manifest), findings });
    return { findings };
  }

  async bindReviewFindings(gate: ReviewGate, findings: ReviewFindingReceipt[]): Promise<string> {
    const receipt = { receipt_version: '2.0.0', receipt_type: 'host-review', gate_id: gate, manifest_digest: objectDigest(this.options.manifest), findings: findings.map((finding) => ({ finding_id: finding.finding_id, severity: finding.severity, message: finding.message, message_digest: finding.message_digest, path: finding.path, applicable_action_ids: finding.applicableActionIds })), receipt_digest: '' };
    receipt.receipt_digest = objectDigest({ ...receipt, receipt_digest: undefined });
    await this.save(`${gate}.json`, receipt);
    return receipt.receipt_digest;
  }

  async repair(cwd: string): Promise<{ changedPaths: string[] }> {
    const capability = this.options.manifest.aggregate_repair;
    const result = await this.invoke(capability.role, 'Host authority aggregate repair', cwd, [...capability.read_scope], [...capability.write_scope], []);
    const value = await validateAuthority(asValue(result));
    if (value.result_type !== 'aggregate-repair') throw new HostAuthorityError('AUTHORITY_INVALID', 'repair authority returned the wrong result type');
    if (value.changed_paths.some((path) => !capability.maximum_write_scope.some((scope) => path === scope || path.startsWith(`${scope}/`)))) throw new HostAuthorityError('AUTHORITY_SCOPE_INVALID', 'repair authority changed a path outside the manifest repair scope');
    await this.save('aggregate-repair.json', value);
    return { changedPaths: value.changed_paths };
  }

  async repairTest(cwd: string, taskId: string): Promise<{ tests: Array<{ command: string; status: 'passed' | 'failed' | 'skipped' }> }> {
    const capability = this.options.manifest.repair_tests.find((entry) => entry.task_id === taskId);
    if (!capability) throw new HostAuthorityError('AUTHORITY_UNAVAILABLE', `manifest repair test authority is unavailable: ${taskId}`);
    const result = await this.invoke(capability.role, `Host authority repair test ${taskId}`, cwd, [...capability.read_scope], [], []);
    const value = await validateAuthority(asValue(result));
    if (value.result_type !== 'repair-test' || value.task_id !== taskId) throw new HostAuthorityError('AUTHORITY_INVALID', `repair test authority returned the wrong task: ${taskId}`);
    for (const command of capability.test_commands) if (!value.tests.some((test) => test.command === command && test.status === 'passed')) throw new HostAuthorityError('AUTHORITY_INVALID', `repair test authority did not pass manifest test command: ${command}`);
    await this.save(`repair-test-${taskId}.json`, value);
    return { tests: value.tests };
  }

  async recheck(gate: ReviewGate, findingId: string, cwd: string, sourceReviewReceiptDigest: string, repairDiffDigest: string): Promise<{ state: 'open' | 'closed'; evidence: string[] }> {
    const capability = this.options.manifest.review_rechecks.find((entry) => entry.gate_id === gate);
    if (!capability) throw new HostAuthorityError('AUTHORITY_UNAVAILABLE', `manifest recheck authority is unavailable: ${gate}`);
    const result = await this.invoke(capability.role, `Host authority finding recheck ${gate} ${findingId}`, cwd, [...capability.read_scope], [], [sourceReviewReceiptDigest, repairDiffDigest]);
    const value = asValue(result);
    const validate = await schemaValidator('review-repair-resolution.schema.json');
    if (!validate(value)) throw new HostAuthorityError('AUTHORITY_INVALID', formatSchemaErrors(validate.errors));
    const receipt = value as FindingRecheckResult;
    if (receipt.finding_id !== findingId || receipt.source_review_receipt_digest !== sourceReviewReceiptDigest || receipt.repair_diff_digest !== repairDiffDigest) throw new HostAuthorityError('AUTHORITY_INVALID', 'finding recheck receipt is not bound to the source review and repair');
    if (receipt.evidence_paths.length !== receipt.evidence_digests.length) throw new HostAuthorityError('AUTHORITY_INVALID', 'finding recheck evidence paths and digests must have the same length');
    for (const [index, path] of receipt.evidence_paths.entries()) {
      const digest = receipt.evidence_digests[index];
      if (!digest || digest !== sha256(await readFile(join(cwd, path)))) throw new HostAuthorityError('AUTHORITY_INVALID', `finding recheck evidence digest does not match: ${path}`);
    }
    await this.save(`finding-recheck-${findingId.slice('finding-sha256:'.length)}.json`, receipt);
    return { state: receipt.status, evidence: receipt.evidence_paths };
  }

  private async invoke(role: AgentPacket['role'], objective: string, cwd: string, readPaths: string[], writePaths: string[], evidence: string[]): Promise<AgentResult> {
    try {
      const needsSandbox = role === 'test' || writePaths.length > 0;
      const sandbox = needsSandbox ? new BrokeredSandboxProvider(undefined, { projectRoot: this.options.project, writePaths: writePaths.map((path) => join(cwd, path)) }) : undefined;
      return await invokeHost(this.options.manifest.host, objective, packet(this.options.manifest, this.options.runId, role, objective, cwd, readPaths, writePaths, evidence, 'schemas/result.schema.json'), sandbox ? { sandbox } : {});
    } catch (error) {
      throw new HostAuthorityError('AUTHORITY_UNAVAILABLE', error instanceof Error ? error.message : String(error));
    }
  }

  private async save(name: string, value: unknown): Promise<void> { await writeJson(join(authorityDirectory(this.options.project, this.options.runId), name), value); }
}
