import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { runHostSmoke } from '../../src/host/smoke.js';
import { exists } from '../../src/utils/fs.js';
import { changedPaths, fakeHosts, snapshotTree, temporary, type FakeHostBehaviors } from '../helpers.js';

/**
 * Smoke harness public contract (from src/host/smoke.ts):
 *
 *   runHostSmoke({
 *     host: 'codex' | 'claude' | 'opencode' | 'all';
 *     home?: string;       // installation HOME; absent or empty is used, non-empty refused
 *     live?: boolean;      // attempt one non-interactive read-only dispatch
 *     keep?: boolean;      // retain the temporary HOME and fixture
 *     timeoutMs?: number;  // internal test injection; the CLI exposes no timeout flag
 *     realHome?: string;   // internal test injection; the CLI uses the actual home
 *     tmpRoot?: string;    // internal test injection; the CLI uses the system temp root
 *   }): Promise<{
 *     matrix: Array<{
 *       host: 'codex' | 'claude' | 'opencode';
 *       version: string;
 *       static_checks: Array<{ id: string; status: 'pass' | 'warn' | 'fail'; detail: string }>;
 *       live: { attempted: boolean; exit_code?: number; marker_found?: boolean; elapsed_ms?: number };
 *       status: 'PASS' | 'UNVERIFIED' | 'BLOCKED';
 *       reason: string;
 *     }>;
 *     retained?: { home: string; fixture: string };
 *   }>
 *
 * A preflight refusal (real-HOME, non-empty `home`, unusable tmpRoot) rejects before any
 * fixture, HOME or host write. PASS requires a live run that exits 0, prints the fixture
 * marker and leaves the fixture unchanged. Without `live`, the entry reports
 * `not_attempted` and can never be PASS. The fixture is always outside HOME.
 */
type Report = Awaited<ReturnType<typeof runHostSmoke>>;
type Entry = Report['matrix'][number];

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temp(prefix: string): Promise<string> {
  const path = await temporary(prefix);
  roots.push(path);
  return path;
}

async function fake(behaviors: FakeHostBehaviors = {}) {
  const hosts = await fakeHosts(behaviors);
  roots.push(hosts.bin);
  vi.stubEnv('PATH', hosts.path);
  return hosts;
}

function only(report: Report): Entry {
  expect(report.matrix).toHaveLength(1);
  const entry = report.matrix[0];
  if (!entry) throw new Error('expected one matrix entry');
  return entry;
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('Expected the call to reject');
}

function nonPass(entry: Entry): void {
  expect(['UNVERIFIED', 'BLOCKED']).toContain(entry.status);
}

describe('runHostSmoke', () => {
  it('reports PASS only for a live host that exits 0, prints the marker and leaves the fixture unchanged', async () => {
    const hosts = await fake({ codex: { version: '9.9.9', mode: 'ok' } });
    const tmpRoot = await temp('ai-workflow-smoke-tmp-');
    const realHome = await temp('ai-workflow-smoke-real-home-');

    const report = await runHostSmoke({ host: 'codex', live: true, realHome, tmpRoot });
    const entry = only(report);

    expect(entry.host).toBe('codex');
    expect(entry.version).toContain('9.9.9');
    expect(Array.isArray(entry.static_checks)).toBe(true);
    expect(entry.static_checks.length).toBeGreaterThan(0);
    expect(entry.live.attempted).toBe(true);
    expect(entry.live.exit_code).toBe(0);
    expect(entry.live.marker_found).toBe(true);
    expect(typeof entry.live.elapsed_ms).toBe('number');
    expect(entry.status, entry.reason).toBe('PASS');
    expect(report.retained).toBeUndefined();
    expect(await readdir(tmpRoot)).toEqual([]);
    expect(await readdir(realHome)).toEqual([]);
    expect((await hosts.calls()).length).toBeGreaterThan(0);
  });

  it('marks a host that exits 0 without the marker as UNVERIFIED', async () => {
    await fake({ codex: { mode: 'nomarker' } });
    const tmpRoot = await temp('ai-workflow-smoke-tmp-');
    const realHome = await temp('ai-workflow-smoke-real-home-');

    const entry = only(await runHostSmoke({ host: 'codex', live: true, realHome, tmpRoot }));

    expect(entry.status).toBe('UNVERIFIED');
    expect(entry.live.attempted).toBe(true);
    expect(entry.live.exit_code).toBe(0);
    expect(entry.live.marker_found).toBe(false);
    expect(entry.reason.length).toBeGreaterThan(0);
  });

  it('records a nonzero live exit and its observed reason without crashing', async () => {
    await fake({ codex: { mode: 'fail', exitCode: 7, stderr: 'authentication required' } });
    const tmpRoot = await temp('ai-workflow-smoke-tmp-');
    const realHome = await temp('ai-workflow-smoke-real-home-');

    const entry = only(await runHostSmoke({ host: 'codex', live: true, realHome, tmpRoot }));

    nonPass(entry);
    expect(entry.live.exit_code).toBe(7);
    expect(entry.reason).toMatch(/authentication/i);
  });

  it('reports a missing executable as UNVERIFIED or BLOCKED without throwing', async () => {
    const hosts = await fakeHosts();
    roots.push(hosts.bin);
    vi.stubEnv('PATH', hosts.minimalPath);
    const tmpRoot = await temp('ai-workflow-smoke-tmp-');
    const realHome = await temp('ai-workflow-smoke-real-home-');

    const report = await runHostSmoke({ host: 'codex', live: true, realHome, tmpRoot });
    const entry = only(report);

    nonPass(entry);
    expect(typeof entry.version).toBe('string');
    expect(entry.reason).toMatch(/codex|not found|ENOENT|executable|unavailable|missing/i);
  });

  it('bounds a hanging live host with the injected timeout', async () => {
    await fake({ codex: { mode: 'timeout' } });
    const tmpRoot = await temp('ai-workflow-smoke-tmp-');
    const realHome = await temp('ai-workflow-smoke-real-home-');

    const entry = only(await runHostSmoke({ host: 'codex', live: true, timeoutMs: 200, realHome, tmpRoot }));

    nonPass(entry);
    expect(entry.reason).toMatch(/timeout|timed out|killed|did not finish|deadline|exceed/i);
    if (typeof entry.live.elapsed_ms === 'number') expect(entry.live.elapsed_ms).toBeLessThan(5000);
  });

  it('never attempts a live dispatch or reports PASS without live', async () => {
    await fake();
    const tmpRoot = await temp('ai-workflow-smoke-tmp-');
    const realHome = await temp('ai-workflow-smoke-real-home-');

    const entry = only(await runHostSmoke({ host: 'claude', live: false, realHome, tmpRoot }));

    expect(entry.status).not.toBe('PASS');
    nonPass(entry);
    expect(entry.live.attempted).toBe(false);
    expect(entry.live.exit_code).toBeUndefined();
    expect(entry.live.marker_found).not.toBe(true);
    expect(entry.reason).toMatch(/not[ _]attempted/i);
  });

  it('keeps the temporary HOME and an external fixture isolated when asked', async () => {
    const hosts = await fake({ opencode: { mode: 'ok' } });
    const tmpRoot = await temp('ai-workflow-smoke-tmp-');
    const realHome = await temp('ai-workflow-smoke-real-home-');
    const realHomeBefore = await snapshotTree(realHome);

    const report = await runHostSmoke({ host: 'opencode', live: true, keep: true, realHome, tmpRoot });
    const entry = only(report);

    expect(entry.status, entry.reason).toBe('PASS');
    const retained = report.retained;
    expect(retained).toBeDefined();
    if (!retained) throw new Error('expected retained paths');
    expect(isAbsolute(retained.home)).toBe(true);
    expect(isAbsolute(retained.fixture)).toBe(true);
    expect(await exists(retained.home)).toBe(true);
    expect(await exists(retained.fixture)).toBe(true);
    const relation = relative(retained.home, retained.fixture);
    expect(relation.startsWith('..') || isAbsolute(relation), 'fixture must be outside HOME').toBe(true);
    expect(relative(realHome, retained.home).startsWith('..')).toBe(true);
    expect(changedPaths(realHomeBefore, await snapshotTree(realHome))).toEqual([]);
    const calls = await hosts.calls();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.HOME === retained.home), JSON.stringify(calls)).toBe(true);
  });

  it('refuses a HOME equal to or inside the injected real HOME before creating a fixture', async () => {
    await fake();
    const tmpRoot = await temp('ai-workflow-smoke-tmp-');
    const realHome = await temp('ai-workflow-smoke-real-home-');
    const nested = join(realHome, 'nested-home');
    const before = await snapshotTree(realHome);

    const error = await rejection(runHostSmoke({ host: 'codex', home: nested, realHome, tmpRoot }));

    expect(error.message).toMatch(/home/i);
    expect(await exists(nested)).toBe(false);
    expect(changedPaths(before, await snapshotTree(realHome))).toEqual([]);
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it('uses an absent --home directory', async () => {
    await fake();
    const tmpRoot = await temp('ai-workflow-smoke-tmp-');
    const realHome = await temp('ai-workflow-smoke-real-home-');
    const parent = await temp('ai-workflow-smoke-home-parent-');
    const home = join(parent, 'home');

    const report = await runHostSmoke({ host: 'codex', home, keep: true, realHome, tmpRoot });

    expect(report.retained?.home).toBe(home);
    expect(await exists(home)).toBe(true);
  });

  it('uses an empty --home directory', async () => {
    await fake();
    const tmpRoot = await temp('ai-workflow-smoke-tmp-');
    const realHome = await temp('ai-workflow-smoke-real-home-');
    const parent = await temp('ai-workflow-smoke-home-parent-');
    const home = join(parent, 'home');
    await mkdir(home);

    const report = await runHostSmoke({ host: 'claude', home, keep: true, realHome, tmpRoot });

    expect(report.retained?.home).toBe(home);
    expect(await exists(home)).toBe(true);
  });

  it('refuses a non-empty --home before any write', async () => {
    await fake();
    const tmpRoot = await temp('ai-workflow-smoke-tmp-');
    const realHome = await temp('ai-workflow-smoke-real-home-');
    const parent = await temp('ai-workflow-smoke-home-parent-');
    const home = join(parent, 'home');
    await mkdir(home);
    await writeFile(join(home, 'keep.txt'), 'user data\n');
    const before = await snapshotTree(home);

    const error = await rejection(runHostSmoke({ host: 'codex', home, realHome, tmpRoot }));

    expect(error.message).toMatch(/empty|non-empty|home/i);
    expect(changedPaths(before, await snapshotTree(home))).toEqual([]);
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it('removes the HOME and fixture without --keep', async () => {
    await fake();
    const tmpRoot = await temp('ai-workflow-smoke-tmp-');
    const realHome = await temp('ai-workflow-smoke-real-home-');
    const parent = await temp('ai-workflow-smoke-home-parent-');
    const home = join(parent, 'home');

    const report = await runHostSmoke({ host: 'codex', home, realHome, tmpRoot });

    expect(report.retained).toBeUndefined();
    expect(await exists(home)).toBe(false);
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it('fails a live entry that modifies the fixture and names the changed path', async () => {
    await fake({ codex: { mode: 'mutate' } });
    const tmpRoot = await temp('ai-workflow-smoke-tmp-');
    const realHome = await temp('ai-workflow-smoke-real-home-');

    const report = await runHostSmoke({ host: 'codex', live: true, keep: true, realHome, tmpRoot });
    const entry = only(report);

    nonPass(entry);
    expect(entry.live.exit_code).toBe(0);
    expect(entry.reason).toContain('mutation.txt');
    expect(report.retained).toBeDefined();
  });

  it('processes every host for host all', async () => {
    await fake();
    const tmpRoot = await temp('ai-workflow-smoke-tmp-');
    const realHome = await temp('ai-workflow-smoke-real-home-');

    const report = await runHostSmoke({ host: 'all', live: false, realHome, tmpRoot });

    expect(report.matrix.map((entry: Entry) => entry.host).sort()).toEqual(['claude', 'codex', 'opencode']);
    for (const entry of report.matrix) {
      nonPass(entry);
      expect(typeof entry.version).toBe('string');
      expect(entry.live.attempted).toBe(false);
    }
  });

  it('rejects when the fixture root cannot be created', async () => {
    await fake();
    const realHome = await temp('ai-workflow-smoke-real-home-');
    const parent = await temp('ai-workflow-smoke-tmp-parent-');
    const unusable = join(parent, 'not-a-directory');
    await writeFile(unusable, 'file\n');

    const error = await rejection(runHostSmoke({ host: 'codex', realHome, tmpRoot: unusable }));

    expect(error).toBeInstanceOf(Error);
  });
});
