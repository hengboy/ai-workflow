import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EventLog } from './events.js';
import { objectDigest } from '../utils/hash.js';
import { exists, writeJson } from '../utils/fs.js';

export type GateId = 'task-closure' | 'plan-validation' | 'standards-review' | 'spec-review' | 'repair-closure' | 'baseline-stable' | 'integration';
export type GateState = 'passed' | 'failed';

export interface TaskClosureGateInput { state: 'finalized' | 'committed' | 'skipped' }
export interface GateInput {
  taskClosure?: Record<string, TaskClosureGateInput>;
  planValidation?: { valid: boolean; errors: string[] };
  review?: { findings: Array<{ severity: 'error' | 'warning' | 'info'; finding_id?: string }> };
  repairClosure?: { closedFindingIds: string[]; expectedFindingIds?: string[] };
  baseline?: { expected: string; current: string };
  integration?: { observed: boolean; noFastForward: boolean; mergeCommit?: string };
}

export interface GateReceipt {
  receipt_version: '2.0.0';
  receipt_type: 'host-gate';
  owner: 'host';
  run_id: string;
  fencing_epoch: number;
  manifest_digest: string;
  gate_id: GateId;
  state: GateState;
  predicate: string;
  evidence: string[];
  receipt_digest: string;
  completed_at: string;
}

export class GateError extends Error {
  readonly name = 'GateError';
  constructor(readonly code: 'GATE_DEPENDENCY_BLOCKED' | 'GATE_HOST_OWNED' | 'GATE_INPUT_INVALID', message: string) { super(message); }
}

const dependencies: Record<GateId, readonly GateId[]> = {
  'task-closure': [],
  'plan-validation': ['task-closure'],
  'standards-review': ['plan-validation'],
  'spec-review': ['plan-validation'],
  'repair-closure': ['plan-validation'],
  'baseline-stable': ['standards-review', 'spec-review', 'repair-closure'],
  integration: ['baseline-stable'],
};

const predicates: Record<GateId, string> = {
  'task-closure': 'all-required-tasks-finalized',
  'plan-validation': 'plan-validation-passed',
  'standards-review': 'review-findings-have-no-errors',
  'spec-review': 'review-findings-have-no-errors',
  'repair-closure': 'every-original-finding-targeted-recheck-closed',
  'baseline-stable': 'baseline-matches-receipt',
  integration: 'target-no-ff-merge-observed',
};

function gatePath(directory: string, gateId: GateId): string { return join(directory, 'receipts', 'gate', `${gateId}.json`); }

export class GateCoordinator {
  private readonly receipts = new Map<GateId, GateReceipt>();
  private readonly eventLog: EventLog;

  constructor(private readonly options: { directory: string; runId: string; fencingEpoch: number; manifestDigest: string; eventLog?: EventLog }) {
    this.eventLog = options.eventLog ?? new EventLog({ path: join(options.directory, 'events.jsonl'), runId: options.runId, fencingEpoch: options.fencingEpoch });
  }

  get states(): Readonly<Record<string, GateState>> { return Object.fromEntries([...this.receipts].map(([gateId, receipt]) => [gateId, receipt.state])); }

  async runGate(gateId: GateId, input: GateInput): Promise<GateReceipt> {
    await this.hydrate();
    for (const dependency of dependencies[gateId]) {
      if (this.receipts.get(dependency)?.state !== 'passed') throw new GateError('GATE_DEPENDENCY_BLOCKED', `${gateId} requires passed gate ${dependency}`);
    }
    const at = new Date().toISOString();
    await this.eventLog.append({ type: 'gate/started', payload: { gate_id: gateId, predicate: predicates[gateId], state: 'started' } });
    const evaluation = this.evaluate(gateId, input);
    const receipt: GateReceipt = { receipt_version: '2.0.0', receipt_type: 'host-gate', owner: 'host', run_id: this.options.runId, fencing_epoch: this.options.fencingEpoch, manifest_digest: this.options.manifestDigest, gate_id: gateId, state: evaluation.passed ? 'passed' : 'failed', predicate: predicates[gateId], evidence: evaluation.evidence, receipt_digest: '', completed_at: at };
    receipt.receipt_digest = objectDigest({ ...receipt, receipt_digest: undefined });
    await writeJson(gatePath(this.options.directory, gateId), receipt);
    await this.eventLog.append({ type: evaluation.passed ? 'gate/passed' : 'gate/failed', payload: { gate_id: gateId, predicate: predicates[gateId], state: receipt.state, receipt_digest: receipt.receipt_digest, reason: evaluation.reason ?? predicates[gateId] } });
    this.receipts.set(gateId, receipt);
    return receipt;
  }

  recordScriptGateState(_gateId: string, _state: string): never {
    throw new GateError('GATE_HOST_OWNED', 'gate state can only be written by the host gate coordinator');
  }

  async readGate(gateId: GateId): Promise<GateReceipt | undefined> {
    await this.hydrate();
    const receipt = this.receipts.get(gateId);
    return receipt ? { ...receipt } : undefined;
  }

  private evaluate(gateId: GateId, input: GateInput): { passed: boolean; evidence: string[]; reason?: string } {
    if (gateId === 'task-closure') {
      const tasks = Object.entries(input.taskClosure ?? {});
      if (!tasks.length) return { passed: false, evidence: [], reason: 'task closure evidence is missing' };
      const incomplete = tasks.find(([, task]) => !['finalized', 'committed', 'skipped'].includes(task.state));
      return incomplete ? { passed: false, evidence: [incomplete[0]], reason: `task is not terminal: ${incomplete[0]}` } : { passed: true, evidence: tasks.map(([taskId]) => taskId) };
    }
    if (gateId === 'plan-validation') {
      const validation = input.planValidation;
      return validation?.valid ? { passed: true, evidence: validation.errors } : { passed: false, evidence: validation?.errors ?? [], reason: 'plan validation failed' };
    }
    if (gateId === 'standards-review' || gateId === 'spec-review') {
      const findings = input.review?.findings ?? [];
      const errors = findings.filter((finding) => finding.severity === 'error');
      return errors.length ? { passed: false, evidence: errors.map((finding) => finding.finding_id ?? 'unidentified-finding'), reason: 'review contains blocking findings' } : { passed: true, evidence: findings.map((finding) => finding.finding_id ?? 'review-complete') };
    }
    if (gateId === 'repair-closure') {
      const closure = input.repairClosure;
      const expected = new Set(closure?.expectedFindingIds ?? closure?.closedFindingIds ?? []);
      const closed = new Set(closure?.closedFindingIds ?? []);
      const missing = [...expected].filter((findingId) => !closed.has(findingId));
      return missing.length || !closure ? { passed: false, evidence: missing, reason: 'original findings are not all closed' } : { passed: true, evidence: [...closed] };
    }
    if (gateId === 'baseline-stable') {
      const baseline = input.baseline;
      return baseline && baseline.expected === baseline.current ? { passed: true, evidence: [baseline.current] } : { passed: false, evidence: baseline ? [baseline.expected, baseline.current] : [], reason: 'baseline drifted' };
    }
    const integration = input.integration;
    return integration?.observed && integration.noFastForward && !!integration.mergeCommit ? { passed: true, evidence: [integration.mergeCommit] } : { passed: false, evidence: [], reason: 'no-ff integration was not observed' };
  }

  private async hydrate(): Promise<void> {
    for (const gateId of Object.keys(dependencies) as GateId[]) {
      if (this.receipts.has(gateId)) continue;
      const path = gatePath(this.options.directory, gateId);
      if (!(await exists(path))) continue;
      const receipt = JSON.parse(await readFile(path, 'utf8')) as GateReceipt;
      if (receipt.owner !== 'host' || receipt.run_id !== this.options.runId || receipt.fencing_epoch !== this.options.fencingEpoch || receipt.manifest_digest !== this.options.manifestDigest) throw new GateError('GATE_HOST_OWNED', `gate receipt does not belong to this host run: ${gateId}`);
      this.receipts.set(gateId, receipt);
    }
  }
}
