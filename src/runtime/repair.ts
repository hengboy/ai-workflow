import { join } from 'node:path';
import { EventLog } from './events.js';
import { objectDigest } from '../utils/hash.js';
import { readJson, writeJson, exists } from '../utils/fs.js';
import { git, V2GitOperator, type V2Worktree } from '../git/operator.js';

export interface ReviewFindingInput {
  sourceGate: 'standards-review' | 'spec-review';
  severity: 'error' | 'warning' | 'info';
  message: string;
  path?: string;
  applicableActionIds: string[];
}

export interface ReviewFindingReceipt extends ReviewFindingInput {
  finding_id: `finding-sha256:${string}`;
  ordinal: number;
  message_digest: string;
}

export interface RepairStartReceipt {
  repair_version: '2.0.0';
  repair_transaction_id: string;
  budget: 1;
  attempt: 1;
  state: 'started';
  findings: ReviewFindingReceipt[];
  worktree: V2Worktree;
  receipt_digest: string;
}

export interface RepairCompletionReceipt {
  repair_transaction_id: string;
  state: 'completed';
  findings: ReviewFindingReceipt[];
  repairCommit: string;
  planHead: string;
  receipt_digest: string;
}

export interface RepairTestReceipt {
  repair_transaction_id: string;
  task_id: string;
  action_id: string;
  call_id: string;
  base_head: string;
  state: 'created';
  worktree: V2Worktree;
  receipt_digest: string;
}

export interface FindingRecheckReceipt {
  finding_id: string;
  state: 'closed';
  evidence: string[];
  receipt_digest: string;
}

export interface RepairStatus { state: 'idle' | 'started' | 'awaiting-rechecks' | 'closed' | 'paused'; findingStates: Record<string, 'open' | 'closed'>; repairAttempts: number }

export class RepairError extends Error {
  readonly name = 'RepairError';
  constructor(readonly code: 'REPAIR_BUDGET_EXHAUSTED' | 'REPAIR_SCOPE_INVALID' | 'REPAIR_STATE_INVALID' | 'REPAIR_TEST_BASE_INVALID' | 'FINDING_RECHECK_OPEN' | 'FINDING_UNKNOWN' | 'REPAIR_RECEIPT_TAMPERED', message: string) { super(message); }
}

function repairPath(directory: string, name: string): string { return join(directory, 'receipts', 'repair', name); }

function findingId(finding: ReviewFindingInput): `finding-sha256:${string}` {
  const messageDigest = objectDigest(finding.message);
  return `finding-sha256:${objectDigest({ source_gate: finding.sourceGate, severity: finding.severity, message_digest: messageDigest, path: finding.path ?? null, applicable_action_ids: [...finding.applicableActionIds].sort() }).slice('sha256:'.length)}`;
}

function normalizeFindings(findings: ReviewFindingInput[]): ReviewFindingReceipt[] {
  return findings.map((finding, index) => ({ ...finding, finding_id: findingId(finding), ordinal: index + 1, message_digest: objectDigest(finding.message) }));
}

export class RepairCoordinator {
  private readonly eventLog: EventLog;
  private readonly findingReceipts = new Map<string, ReviewFindingReceipt>();
  private readonly rechecks = new Map<string, FindingRecheckReceipt>();
  private attempts = 0;
  private currentState: RepairStatus['state'] = 'idle';
  private startReceipt?: RepairStartReceipt;
  private completion?: RepairCompletionReceipt;

  constructor(private readonly options: { project: string; runId: string; manifestDigest: string; fencingEpoch: number; operator: V2GitOperator; directory?: string; eventLog?: EventLog }) {
    this.eventLog = options.eventLog ?? new EventLog({ path: join(options.project, '.ai-workflow/runs', options.runId, 'events.jsonl'), runId: options.runId, fencingEpoch: options.fencingEpoch });
  }

  async startRepair(findings: ReviewFindingInput[]): Promise<RepairStartReceipt> {
    await this.hydrate();
    if (this.attempts >= 1 || this.currentState !== 'idle') {
      this.currentState = 'paused';
      await this.persistStatus();
      throw new RepairError('REPAIR_BUDGET_EXHAUSTED', 'aggregate repair budget is one attempt per run');
    }
    const normalized = normalizeFindings(findings);
    if (!normalized.length) throw new RepairError('REPAIR_STATE_INVALID', 'aggregate repair requires at least one finding');
    const allowed = new Set(this.options.operator.resources.flatMap((resource) => resource.canonical_path ? [resource.canonical_path] : []));
    const worktree = await this.options.operator.createRepairWorktree(await this.planHead());
    const receipt: RepairStartReceipt = { repair_version: '2.0.0', repair_transaction_id: `repair-${this.options.runId}-1`, budget: 1, attempt: 1, state: 'started', findings: normalized, worktree, receipt_digest: '' };
    receipt.receipt_digest = objectDigest({ ...receipt, receipt_digest: undefined, worktree: worktree.resource.resource_id });
    if (allowed.has(worktree.resource.canonical_path ?? '')) throw new RepairError('REPAIR_SCOPE_INVALID', 'repair worktree unexpectedly overlaps an existing resource');
    for (const finding of normalized) this.findingReceipts.set(finding.finding_id, finding);
    this.startReceipt = receipt;
    this.attempts = 1;
    this.currentState = 'started';
    await writeJson(repairPath(this.directory(), 'start.json'), receipt);
    await this.eventLog.append({ type: 'repair/started', payload: { action_id: 'plan-aggregate-repair', state: 'started', finding_ids: normalized.map((finding) => finding.finding_id), resource_id: worktree.resource.resource_id, receipt_digest: receipt.receipt_digest } });
    return receipt;
  }

  async completeRepair(start: RepairStartReceipt, writeScope: string[]): Promise<RepairCompletionReceipt> {
    await this.hydrate();
    if (this.startReceipt?.receipt_digest !== start.receipt_digest || this.currentState !== 'started') throw new RepairError('REPAIR_RECEIPT_TAMPERED', 'repair start receipt is not the current host receipt');
    if (writeScope.some((path) => !start.findings.some((finding) => !finding.path || path === finding.path || path.startsWith(`${finding.path}/`)))) throw new RepairError('REPAIR_SCOPE_INVALID', 'repair changed path is outside finding scope');
    const commit = await this.options.operator.commitTask(start.worktree, 'plan-aggregate-repair', writeScope);
    const plan = this.planWorktree();
    const planHead = await this.options.operator.mergeTask(plan, commit.commit);
    const receipt: RepairCompletionReceipt = { repair_transaction_id: start.repair_transaction_id, state: 'completed', findings: start.findings, repairCommit: commit.commit, planHead, receipt_digest: '' };
    receipt.receipt_digest = objectDigest({ ...receipt, receipt_digest: undefined });
    this.completion = receipt;
    this.currentState = 'awaiting-rechecks';
    await writeJson(repairPath(this.directory(), 'completed.json'), receipt);
    await this.eventLog.append({ type: 'repair/completed', payload: { action_id: 'plan-aggregate-repair', state: 'completed', finding_ids: start.findings.map((finding) => finding.finding_id), commit: commit.commit, head: planHead, receipt_digest: receipt.receipt_digest } });
    return receipt;
  }

  async createRepairTest(taskId: string, baseHead: string): Promise<RepairTestReceipt> {
    await this.hydrate();
    if (this.currentState !== 'awaiting-rechecks' || !this.completion || this.completion.planHead !== baseHead) throw new RepairError('REPAIR_TEST_BASE_INVALID', 'repair-test must use the observed plan HEAD after repair merge');
    const worktree = await this.options.operator.createRepairTestWorktree(taskId, baseHead);
    const receipt: RepairTestReceipt = { repair_transaction_id: this.completion.repair_transaction_id, task_id: taskId, action_id: `${taskId}-repair-test`, call_id: `host/repair-test/${this.completion.repair_transaction_id}/${taskId}`, base_head: baseHead, state: 'created', worktree, receipt_digest: '' };
    receipt.receipt_digest = objectDigest({ ...receipt, receipt_digest: undefined, worktree: worktree.resource.resource_id });
    await writeJson(repairPath(this.directory(), `repair-test-${taskId}.json`), receipt);
    await this.eventLog.append({ type: 'resource/created', task_id: taskId, payload: { resource_id: worktree.resource.resource_id, action_id: receipt.action_id, kind: 'repair-test-worktree', branch: worktree.branch, head: baseHead, path: worktree.resource.canonical_path ?? '' } });
    return receipt;
  }

  async recheckFinding(findingId: string, result: { state: 'open' | 'closed'; evidence: string[] }): Promise<FindingRecheckReceipt> {
    await this.hydrate();
    if (!this.findingReceipts.has(findingId)) throw new RepairError('FINDING_UNKNOWN', `unknown finding: ${findingId}`);
    if (result.state !== 'closed' || !result.evidence.length) throw new RepairError('FINDING_RECHECK_OPEN', `finding remains open: ${findingId}`);
    const receipt: FindingRecheckReceipt = { finding_id: findingId, state: 'closed', evidence: [...result.evidence], receipt_digest: objectDigest({ finding_id: findingId, state: 'closed', evidence: result.evidence }) };
    this.rechecks.set(findingId, receipt);
    if (this.startReceipt && this.rechecks.size === this.startReceipt.findings.length) this.currentState = 'closed';
    await writeJson(repairPath(this.directory(), `finding-${findingId.replaceAll(':', '-')}.json`), receipt);
    await this.eventLog.append({ type: 'review/result', payload: { finding_id: findingId, state: receipt.state, evidence_paths: receipt.evidence, receipt_digest: receipt.receipt_digest } });
    await this.persistStatus();
    return receipt;
  }

  async status(): Promise<RepairStatus> {
    await this.hydrate();
    return { state: this.currentState, findingStates: Object.fromEntries([...this.findingReceipts].map(([id]) => [id, this.rechecks.has(id) ? 'closed' : 'open'])), repairAttempts: this.attempts };
  }

  private directory(): string { return this.options.directory ?? join(this.options.project, '.ai-workflow/runs', this.options.runId); }

  private async planHead(): Promise<string> {
    const plan = this.planWorktree();
    return git(plan.path, ['rev-parse', 'HEAD']);
  }

  private planWorktree(): V2Worktree {
    const resource = this.options.operator.resources.find((candidate) => candidate.kind === 'plan-worktree');
    if (!resource?.canonical_path || !resource.branch) throw new RepairError('REPAIR_STATE_INVALID', 'plan worktree receipt is missing');
    return { path: join(this.options.project, resource.canonical_path), branch: resource.branch, base: resource.base_ref, resource, branchResource: this.options.operator.resources.find((candidate) => candidate.kind === 'plan-branch' && candidate.branch === resource.branch) ?? resource };
  }

  private async hydrate(): Promise<void> {
    if (this.startReceipt || !(await exists(repairPath(this.directory(), 'start.json')))) return;
    this.startReceipt = await readJson<RepairStartReceipt>(repairPath(this.directory(), 'start.json'));
    this.attempts = this.startReceipt.attempt;
    for (const finding of this.startReceipt.findings) this.findingReceipts.set(finding.finding_id, finding);
    if (await exists(repairPath(this.directory(), 'completed.json'))) { this.completion = await readJson<RepairCompletionReceipt>(repairPath(this.directory(), 'completed.json')); this.currentState = 'awaiting-rechecks'; }
    else this.currentState = 'started';
    for (const finding of this.findingReceipts.keys()) {
      const path = repairPath(this.directory(), `finding-${finding.replaceAll(':', '-')}.json`);
      if (await exists(path)) {
        const receipt = await readJson<FindingRecheckReceipt>(path);
        if (receipt.finding_id !== finding || receipt.state !== 'closed' || !receipt.evidence.length) throw new RepairError('REPAIR_RECEIPT_TAMPERED', `finding recheck receipt is invalid: ${finding}`);
        this.rechecks.set(finding, receipt);
      }
    }
    if (this.startReceipt && this.rechecks.size === this.startReceipt.findings.length) this.currentState = 'closed';
  }

  private async persistStatus(): Promise<void> { await writeJson(repairPath(this.directory(), 'status.json'), { state: this.currentState, findingStates: Object.fromEntries([...this.findingReceipts].map(([id]) => [id, this.rechecks.has(id) ? 'closed' : 'open'])), repairAttempts: this.attempts }); }
}
