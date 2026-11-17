import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import { findUnfinishedRuns, resumeRun } from '../../src/execution/recovery.js';
import { DEFAULT_EXECUTION_CONFIG } from '../../src/execution/config.js';
import { executionPaths } from '../../src/execution/paths.js';
import { readEvents, readLatestCheckpoint, readLock, readRun, writeRun } from '../../src/execution/store.js';
import type { ExecutionLock, ExecutionRun } from '../../src/execution/types.js';
import { writeOrdinaryRecord } from '../../src/execution/record.js';
import { cancelRun, completeRun, failRun, pauseRun, recordTask, startRun } from '../../src/execution/manager.js';
import { changedPaths, snapshotTree, temporary, workspacePlanFixture } from '../helpers.js';

// Public boundary under test: unfinished-run discovery and the explicit resume packet.
// These tests build real frozen plans and real runs through the lifecycle manager, then apply
// bounded direct file edits to create stale/corrupt/contradictory state. Expected RED: the
// recovery module does not exist yet, so this file fails at import time.

const HOST = hostname();
const NOW = '2026-11-17T00:00:00.000Z';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const DEAD_PID = 2_000_000_000;

const T1 = 'task-001-first';
const T2 = 'task-002-second';

/** Exact manual/refusal reasons the public packet must report. */
const REASON = {
  digest: 'Execution run plan digest does not match the frozen plan',
  repository: 'Execution run repository does not match the requested repository',
  liveLock: 'Execution lock is held by a live process',
  otherHostLock: 'Execution lock is held by another host',
  missingRecord: 'Implementation record is absent',
  contradictoryTask: (taskId: string) => `Contradictory task evidence for ${taskId}`,
  noCheckpoint: 'No valid execution checkpoint is available',
  ambiguous: 'Multiple execution runs found; select one with --plan',
  noRun: 'No execution run found for the project',
  terminalCompleted: 'Execution run is already COMPLETED',
  terminalFailed: 'Execution run is already FAILED',
  terminalCancelled: 'Execution run was CANCELLED',
} as const;

interface Packet {
  valid: boolean;
  decision: 'resume' | 'manual' | 'refused';
  reason?: string;
  plan_id?: string;
  plan_directory?: string;
  run_id?: string;
  status?: string;
  phase?: string;
  checkpoint?: any;
  agent?: any;
  completed_tasks?: string[];
  pending_tasks?: string[];
  warnings?: string[];
  reconciled?: boolean;
  [key: string]: unknown;
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function newRoot(): Promise<string> {
  const root = await temporary('ai-workflow-recovery-');
  roots.push(root);
  return root;
}

async function splitFixture(planId = '20261117-recovery'): Promise<{ root: string; planDirectory: string; paths: ReturnType<typeof executionPaths> }> {
  const root = await newRoot();
  const planDirectory = await workspacePlanFixture(root, {
    planId,
    requirements: ['REQ-001', 'REQ-002'],
    acceptanceCriteria: ['AC-001', 'AC-002'],
    tasks: [
      { id: T1, requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'], writeScope: ['src/first.ts'] },
      { id: T2, requirements: ['REQ-002'], acceptanceCriteria: ['AC-002'], writeScope: ['src/second.ts'] },
    ],
    phases: [[T1], [T2]],
  });
  return { root, planDirectory, paths: executionPaths(planDirectory) };
}

async function startedSplit(planId?: string): Promise<{ root: string; planDirectory: string; paths: ReturnType<typeof executionPaths> }> {
  const fixture = await splitFixture(planId);
  await startRun({ planDirectory: fixture.planDirectory, config: DEFAULT_EXECUTION_CONFIG });
  return fixture;
}

/** Add a started run with an overridden status and optional lock state under one root. */
async function addRun(
  root: string,
  planId: string,
  status: ExecutionRun['status'],
  lockState?: 'stale' | 'other-host' | 'none',
): Promise<{ planDirectory: string; paths: ReturnType<typeof executionPaths>; run: ExecutionRun }> {
  const planDirectory = await workspacePlanFixture(root, {
    planId,
    requirements: ['REQ-001'],
    acceptanceCriteria: ['AC-001'],
    tasks: [],
    phases: [],
  });
  await startRun({ planDirectory, config: DEFAULT_EXECUTION_CONFIG });
  const paths = executionPaths(planDirectory);
  const run = await readRun(paths);
  await writeRun(paths, { ...run, status });
  if (lockState === 'none') await rm(paths.lock, { force: true });
  if (lockState === 'stale' || lockState === 'other-host') {
    const current = (await readLock(paths)) ?? { owner_id: 'owner', pid: 1, host: HOST, acquired_at: NOW, command: 'test' };
    const edited: ExecutionLock = {
      ...current,
      pid: DEAD_PID,
      ...(lockState === 'other-host' ? { host: 'another-host' } : {}),
    };
    await writeFile(paths.lock, `${JSON.stringify(edited, null, 2)}\n`);
  }
  return { planDirectory, paths, run };
}

async function makeStaleLock(paths: ReturnType<typeof executionPaths>): Promise<void> {
  const current = await readLock(paths);
  expect(current, 'a started run holds a lock').toBeDefined();
  await writeFile(paths.lock, `${JSON.stringify({ ...current, pid: DEAD_PID, host: HOST }, null, 2)}\n`);
}

async function eventTypes(paths: ReturnType<typeof executionPaths>): Promise<string[]> {
  return (await readEvents(paths)).events.map((event) => event.type);
}

function checkpointId(result: Awaited<ReturnType<typeof readLatestCheckpoint>>): string | undefined {
  if (result.status !== 'ok') return undefined;
  return result.checkpoint.checkpoint_id;
}

function assertNoSessionRestoreClaim(packet: Packet): void {
  const claims = Object.keys(packet).filter((key) => /restor|reconnect|reattach/i.test(key));
  expect(claims, 'a resume packet never claims a host session was restored').toEqual([]);
}

async function frozenSnapshot(planDirectory: string): Promise<Record<string, string>> {
  return {
    'spec.md': await readFile(join(planDirectory, 'spec.md'), 'utf8'),
    'plan.md': await readFile(join(planDirectory, 'plan.md'), 'utf8'),
    'tasks/execution-order.yaml': await readFile(join(planDirectory, 'tasks', 'execution-order.yaml'), 'utf8'),
    'implementation.yaml': await readFile(join(planDirectory, 'implementation.yaml'), 'utf8'),
  };
}

async function expectFrozenUnchanged(planDirectory: string, before: Record<string, string>): Promise<void> {
  expect(await frozenSnapshot(planDirectory), 'recovery never rewrites frozen plans or the authoritative record').toEqual(before);
}

async function expectNoRecoveryEvents(paths: ReturnType<typeof executionPaths>, before: string[]): Promise<void> {
  const after = await eventTypes(paths);
  for (const type of ['execution.resumed', 'execution.reconciled']) {
    expect(after.filter((entry) => entry === type), `no ${type} event on a refusal`).toHaveLength(before.filter((entry) => entry === type).length);
  }
}

describe('findUnfinishedRuns (REQ-010 phase notice)', () => {
  it('returns only unfinished statuses with the exact bounded run shape and reads no file', async () => {
    const root = await newRoot();
    const statuses = ['CREATED', 'RUNNING', 'PAUSED', 'INTERRUPTED', 'RESUMING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;
    const directories = new Map<string, string>();
    for (const [index, status] of statuses.entries()) {
      const planId = `20261120-plan-${index}-${status.toLowerCase()}`;
      const { planDirectory } = await addRun(root, planId, status);
      directories.set(status, planDirectory);
    }

    const before = await snapshotTree(root);
    const { runs, warnings } = await findUnfinishedRuns(root);

    expect(warnings, 'a full metadata set yields no warnings').toEqual([]);
    expect(runs.map((run) => run.status).sort()).toEqual(['CREATED', 'INTERRUPTED', 'PAUSED', 'RESUMING', 'RUNNING']);
    for (const run of runs) {
      expect(Object.keys(run).sort()).toEqual(['lock', 'plan_directory', 'plan_id', 'run_id', 'status', 'updated_at'].sort());
      expect(run.plan_directory).toBe(directories.get(run.status));
      expect(run.plan_id).toBe(basename(run.plan_directory));
      expect(typeof run.run_id).toBe('string');
      expect(run.run_id.length).toBeGreaterThan(0);
      expect(typeof run.updated_at).toBe('string');
      expect(['none', 'held', 'stale', 'other-host', 'unreadable']).toContain(run.lock);
    }
    expect(changedPaths(before, await snapshotTree(root)), 'discovery is read-only').toEqual([]);
  });

  it('classifies lock staleness and bounds the scan with maxPlans', async () => {
    const root = await newRoot();
    await addRun(root, '20261117-plan-held', 'RUNNING');
    await addRun(root, '20261117-plan-stale', 'RUNNING', 'stale');
    await addRun(root, '20261117-plan-other', 'RUNNING', 'other-host');
    await addRun(root, '20261117-plan-none', 'PAUSED', 'none');

    const { runs } = await findUnfinishedRuns(root);
    const byPlan = new Map(runs.map((run) => [run.plan_id, run]));
    expect(byPlan.get('20261117-plan-held')?.lock).toBe('held');
    expect(byPlan.get('20261117-plan-stale')?.lock).toBe('stale');
    expect(byPlan.get('20261117-plan-other')?.lock).toBe('other-host');
    expect(byPlan.get('20261117-plan-none')?.lock).toBe('none');

    const bounded = await findUnfinishedRuns(root, { maxPlans: 1 });
    expect(bounded.runs.length).toBeLessThanOrEqual(1);
    expect(bounded.warnings).toEqual([]);
  });

  it('reports a malformed run as a warning without throwing or listing it', async () => {
    const root = await newRoot();
    const good = await addRun(root, '20261117-plan-good', 'RUNNING');
    const badPlan = await workspacePlanFixture(root, {
      planId: 'plan-bad',
      requirements: ['REQ-001'],
      acceptanceCriteria: ['AC-001'],
      tasks: [],
      phases: [],
    });
    const badPaths = executionPaths(badPlan);
    await mkdir(badPaths.directory, { recursive: true });
    await writeFile(badPaths.run, '{ this is not valid json\n');

    const { runs, warnings } = await findUnfinishedRuns(root);
    expect(runs.map((run) => run.plan_id)).toContain(good.run.plan_id);
    expect(runs.map((run) => run.plan_id)).not.toContain('plan-bad');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((warning) => warning.includes('plan-bad')), 'the warning names the malformed plan').toBe(true);
  });
});

describe('resumeRun success packets (REQ-010 / REQ-011)', () => {
  it('resumes a RUNNING run with a stale lock, preserving run id and separating completed from pending tasks', async () => {
    const fixture = await startedSplit();
    await recordTask({ planDirectory: fixture.planDirectory, taskId: T1, commit: SHA_A });
    const before = await readRun(fixture.paths);
    const beforeCheckpointId = checkpointId(await readLatestCheckpoint(fixture.paths));
    expect(beforeCheckpointId).toBeTruthy();
    const beforeTypes = await eventTypes(fixture.paths);
    await makeStaleLock(fixture.paths);

    const { packet: raw, exitCode } = await resumeRun({
      planDirectory: fixture.planDirectory,
      host: HOST,
      pid: 424242,
      ownerId: 'resume-owner',
      now: NOW,
      config: DEFAULT_EXECUTION_CONFIG,
    });
    const packet = raw as Packet;

    expect(exitCode).toBe(0);
    expect(packet.valid).toBe(true);
    expect(packet.decision).toBe('resume');
    expect(packet.run_id).toBe(before.run_id);
    expect(packet.plan_id).toBe(before.plan_id);
    expect(packet.plan_directory).toBe(fixture.planDirectory);
    expect(packet.status).toBe('RUNNING');
    expect(packet.completed_tasks).toEqual([T1]);
    expect(packet.pending_tasks).toEqual([T2]);
    expect(packet.pending_tasks).not.toContain(T1);
    expect(Array.isArray(packet.warnings)).toBe(true);

    const afterTypes = await eventTypes(fixture.paths);
    expect(afterTypes.filter((type) => type === 'execution.interrupted'))
      .toHaveLength(beforeTypes.filter((type) => type === 'execution.interrupted').length + 1);
    expect(afterTypes.filter((type) => type === 'execution.resumed')).toHaveLength(1);
    expect(await readLock(fixture.paths), 'the resume reacquires the lock').toBeDefined();
    expect((await readRun(fixture.paths)).status).toBe('RUNNING');
    expect(checkpointId(await readLatestCheckpoint(fixture.paths)), 'a fresh checkpoint is written').not.toBe(beforeCheckpointId);
    assertNoSessionRestoreClaim(packet);
  });

  it('resumes a PAUSED run without recording a new interruption event', async () => {
    const fixture = await startedSplit();
    await recordTask({ planDirectory: fixture.planDirectory, taskId: T1, commit: SHA_A });
    await pauseRun({ planDirectory: fixture.planDirectory });
    const before = await readRun(fixture.paths);
    expect(before.status).toBe('PAUSED');
    const interruptionsBefore = (await eventTypes(fixture.paths)).filter((type) => type === 'execution.interrupted').length;

    const { packet: raw, exitCode } = await resumeRun({
      planDirectory: fixture.planDirectory,
      host: HOST,
      pid: 424242,
      ownerId: 'resume-owner',
      now: NOW,
    });
    const packet = raw as Packet;

    expect(exitCode).toBe(0);
    expect(packet.decision).toBe('resume');
    expect(packet.status).toBe('RUNNING');
    expect(packet.run_id).toBe(before.run_id);
    expect(packet.completed_tasks).toEqual([T1]);
    expect(packet.pending_tasks).toEqual([T2]);
    const afterTypes = await eventTypes(fixture.paths);
    expect(afterTypes.filter((type) => type === 'execution.interrupted'), 'no new interruption for a paused resume').toHaveLength(interruptionsBefore);
    expect(afterTypes.filter((type) => type === 'execution.resumed')).toHaveLength(1);
    expect(await readLock(fixture.paths), 'the pause released it and the resume reacquires it').toBeDefined();
  });

  it('reconciles a run to COMPLETED when the authoritative completed record matches', async () => {
    const fixture = await startedSplit();
    await recordTask({ planDirectory: fixture.planDirectory, taskId: T1, commit: SHA_A });
    await recordTask({ planDirectory: fixture.planDirectory, taskId: T2, commit: SHA_A });
    const before = await readRun(fixture.paths);
    await makeStaleLock(fixture.paths);
    const recordPath = join(fixture.planDirectory, 'implementation.yaml');
    await writeOrdinaryRecord(recordPath, {
      plan_id: before.plan_id,
      status: 'completed',
      started_at: '2026-11-17T01:00:00+08:00',
      completed_at: '2026-11-17T02:00:00+08:00',
      commit: SHA_A,
    });
    const recordBytes = await readFile(recordPath, 'utf8');

    const { packet: raw, exitCode } = await resumeRun({
      planDirectory: fixture.planDirectory,
      host: HOST,
      pid: 424242,
      ownerId: 'resume-owner',
      now: NOW,
    });
    const packet = raw as Packet;

    expect(exitCode).toBe(0);
    expect(packet.valid).toBe(true);
    expect(packet.decision).toBe('resume');
    expect(packet.status).toBe('COMPLETED');
    expect(packet.reconciled).toBe(true);
    expect(packet.run_id).toBe(before.run_id);
    expect(packet.pending_tasks).toEqual([]);
    expect(packet.completed_tasks).toEqual([T1, T2]);
    expect(await eventTypes(fixture.paths)).toContain('execution.reconciled');
    expect(await readLock(fixture.paths), 'reconciliation releases the lock').toBeUndefined();
    expect(await readFile(recordPath, 'utf8'), 'the authoritative record is not rewritten').toBe(recordBytes);
  });
});

describe('resumeRun manual refusals (REQ-011 / AC-019)', () => {
  async function expectManual(
    fixture: { planDirectory: string; paths: ReturnType<typeof executionPaths> },
    overrides: Record<string, unknown>,
    reason: string,
  ): Promise<Packet> {
    const beforeTypes = await eventTypes(fixture.paths);
    const before = await frozenSnapshot(fixture.planDirectory);
    const { packet: raw, exitCode } = await resumeRun({
      planDirectory: fixture.planDirectory,
      host: HOST,
      pid: 424242,
      ownerId: 'resume-owner',
      now: NOW,
      ...overrides,
    });
    const packet = raw as Packet;
    expect(exitCode, `manual refusal for ${reason}`).toBe(1);
    expect(packet.valid).toBe(false);
    expect(packet.decision).toBe('manual');
    expect(packet.reason).toBe(reason);
    await expectFrozenUnchanged(fixture.planDirectory, before);
    await expectNoRecoveryEvents(fixture.paths, beforeTypes);
    return packet;
  }

  it('refuses a changed plan digest', async () => {
    const fixture = await startedSplit();
    const run = await readRun(fixture.paths);
    const raw = JSON.parse(await readFile(fixture.paths.run, 'utf8')) as Record<string, unknown>;
    const hex = String(raw.plan_digest).slice('sha256:'.length);
    const changedDigest = `sha256:${hex[0] === '0' ? '1' : '0'}${hex.slice(1)}`;
    await writeFile(fixture.paths.run, `${JSON.stringify({ ...raw, plan_digest: changedDigest }, null, 2)}\n`);
    const packet = await expectManual(fixture, {}, REASON.digest);
    expect(packet.run_id).toBe(run.run_id);
  });

  it('refuses a repository mismatch when a repository is supplied', async () => {
    const fixture = await startedSplit();
    const run = await readRun(fixture.paths);
    await writeRun(fixture.paths, { ...run, repository: 'app' });
    await expectManual(fixture, { repository: 'other-repo' }, REASON.repository);
  });

  it('refuses a live same-host lock', async () => {
    const fixture = await startedSplit();
    expect(await readLock(fixture.paths), 'a fresh run holds a live lock owned by this process').toBeDefined();
    await expectManual(fixture, {}, REASON.liveLock);
  });

  it('refuses another host lock without touching its bytes', async () => {
    const fixture = await startedSplit();
    const otherHostLock = { owner_id: 'other', pid: DEAD_PID, host: 'another-host', acquired_at: NOW, command: 'start' };
    await writeFile(fixture.paths.lock, `${JSON.stringify(otherHostLock, null, 2)}\n`);
    const lockBytes = await readFile(fixture.paths.lock, 'utf8');
    await expectManual(fixture, {}, REASON.otherHostLock);
    expect(await readFile(fixture.paths.lock, 'utf8'), 'another host lock is never released').toBe(lockBytes);
  });

  it('refuses an absent authoritative implementation record', async () => {
    const fixture = await startedSplit();
    await rm(join(fixture.planDirectory, 'implementation.yaml'));
    const beforeTypes = await eventTypes(fixture.paths);
    const { packet: raw, exitCode } = await resumeRun({
      planDirectory: fixture.planDirectory, host: HOST, pid: 424242, ownerId: 'resume-owner', now: NOW,
    });
    const packet = raw as Packet;
    expect(exitCode).toBe(1);
    expect(packet.decision).toBe('manual');
    expect(packet.reason).toBe(REASON.missingRecord);
    expect(await readFile(join(fixture.planDirectory, 'spec.md'), 'utf8')).toBeTruthy();
    const recordExists = await readFile(join(fixture.planDirectory, 'implementation.yaml'), 'utf8').then(() => true, () => false);
    expect(recordExists, 'recovery never recreates a missing authoritative record').toBe(false);
    await expectNoRecoveryEvents(fixture.paths, beforeTypes);
  });

  it('refuses contradictory task evidence between a run commit and its task.completed event', async () => {
    const fixture = await startedSplit();
    await recordTask({ planDirectory: fixture.planDirectory, taskId: T1, commit: SHA_A });
    const run = await readRun(fixture.paths);
    await writeRun(fixture.paths, {
      ...run,
      tasks: { ...run.tasks, [T1]: { ...run.tasks![T1]!, commit: SHA_B } },
    });
    await expectManual(fixture, {}, REASON.contradictoryTask(T1));
  });

  it('refuses a checkpoint set that exists but has no valid checkpoint', async () => {
    const fixture = await startedSplit();
    const files = await readdir(fixture.paths.checkpoints);
    expect(files.length, 'a started run has a checkpoint').toBeGreaterThan(0);
    for (const name of files) await writeFile(join(fixture.paths.checkpoints, name), '{ corrupt\n');
    await expectManual(fixture, {}, REASON.noCheckpoint);
  });
});

describe('resumeRun terminal refusals and scope resolution (REQ-010 / AC-018)', () => {
  for (const [status, reason] of [['COMPLETED', REASON.terminalCompleted], ['FAILED', REASON.terminalFailed], ['CANCELLED', REASON.terminalCancelled]] as const) {
    it(`refuses a terminal ${status} run without restarting it`, async () => {
      const fixture = await startedSplit();
      if (status === 'COMPLETED') await completeRun({ planDirectory: fixture.planDirectory, commit: SHA_A });
      if (status === 'FAILED') await failRun({ planDirectory: fixture.planDirectory, category: 'authentication' });
      if (status === 'CANCELLED') await cancelRun({ planDirectory: fixture.planDirectory });
      const before = await readRun(fixture.paths);
      expect(before.status).toBe(status);
      const beforeTypes = await eventTypes(fixture.paths);
      const beforeSnapshot = await frozenSnapshot(fixture.planDirectory);

      const { packet: raw, exitCode } = await resumeRun({
        planDirectory: fixture.planDirectory, host: HOST, pid: 424242, ownerId: 'resume-owner', now: NOW,
      });
      const packet = raw as Packet;
      expect(exitCode).toBe(1);
      expect(packet.valid).toBe(false);
      expect(packet.decision).toBe('refused');
      expect(packet.reason).toBe(reason);
      expect((await readRun(fixture.paths)).status).toBe(status);
      await expectFrozenUnchanged(fixture.planDirectory, beforeSnapshot);
      await expectNoRecoveryEvents(fixture.paths, beforeTypes);
    });
  }

  it('returns the exact no-run reason for an empty project', async () => {
    const root = await newRoot();
    const { packet: raw, exitCode } = await resumeRun({ projectRoot: root, host: HOST, pid: 424242, now: NOW });
    const packet = raw as Packet;
    expect(exitCode).toBe(1);
    expect(packet.valid).toBe(false);
    expect(packet.decision).toBe('manual');
    expect(packet.reason).toBe(REASON.noRun);
  });

  it('returns the exact ambiguity reason for two runs without a plan directory', async () => {
    const root = await newRoot();
    await addRun(root, '20261117-plan-one', 'PAUSED', 'none');
    await addRun(root, '20261117-plan-two', 'PAUSED', 'none');
    const { packet: raw, exitCode } = await resumeRun({ projectRoot: root, host: HOST, pid: 424242, now: NOW });
    const packet = raw as Packet;
    expect(exitCode).toBe(1);
    expect(packet.valid).toBe(false);
    expect(packet.decision).toBe('manual');
    expect(packet.reason).toBe(REASON.ambiguous);
  });

  it('resolves a single unambiguous run from the project root', async () => {
    const root = await newRoot();
    const { run } = await addRun(root, '20261117-plan-only', 'PAUSED', 'none');
    const { packet: raw, exitCode } = await resumeRun({ projectRoot: root, host: HOST, pid: 424242, ownerId: 'resume-owner', now: NOW });
    const packet = raw as Packet;
    expect(exitCode).toBe(0);
    expect(packet.valid).toBe(true);
    expect(packet.decision).toBe('resume');
    expect(packet.run_id).toBe(run.run_id);
    expect(packet.plan_id).toBe(run.plan_id);
  });
});
