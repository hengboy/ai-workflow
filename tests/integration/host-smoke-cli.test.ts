import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { exists } from '../../src/utils/fs.js';
import { changedPaths, fakeHosts, snapshotTree, temporary, type FakeHostBehaviors } from '../helpers.js';

/**
 * CLI contract:
 *
 *   ai-workflow host smoke --host codex|claude|opencode|all [--home <path>] [--live] [--keep]
 *
 * Prints JSON `{ matrix: [...], retained?: { home, fixture } }` with one matrix entry per
 * processed host and `status` PASS | UNVERIFIED | BLOCKED. A completed matrix exits 0 even
 * when entries are UNVERIFIED or BLOCKED. A real-HOME refusal, a non-empty `--home` and a
 * fixture/setup failure exit 1. `--keep` retains the temporary HOME and the external fixture
 * and reports both absolute paths. The test uses fake host executables only; no real
 * codex/claude/opencode, network, remote or real HOME is touched.
 */
interface SmokeEntry {
  host: 'codex' | 'claude' | 'opencode';
  version: string;
  static_checks: unknown[];
  live: { attempted: boolean; exit_code?: number; marker_found?: boolean; elapsed_ms?: number };
  status: 'PASS' | 'UNVERIFIED' | 'BLOCKED';
  reason: string;
}

interface SmokeReport {
  matrix: SmokeEntry[];
  retained?: { home: string; fixture: string };
}

const exec = promisify(execFile);
const cli = ['exec', 'tsx', 'src/cli.ts'] as const;
const roots: string[] = [];

type CliResult = { code: number; stdout: string; stderr: string };

afterEach(async () => {
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
  return hosts;
}

async function runCli(args: string[], env: Record<string, string>): Promise<CliResult> {
  try {
    const { stdout, stderr } = await exec('pnpm', [...cli, ...args], {
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failure.code === 'number' ? failure.code : 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

function parse(result: CliResult): SmokeReport {
  return JSON.parse(result.stdout) as SmokeReport;
}

function nonPass(entry: SmokeEntry): void {
  expect(['UNVERIFIED', 'BLOCKED']).toContain(entry.status);
}

describe('host smoke CLI', () => {
  it('processes every host with live fake executables and exits 0', async () => {
    const hosts = await fake();
    const tmpRoot = await temp('ai-workflow-smoke-cli-tmp-');

    const result = await runCli(['host', 'smoke', '--host', 'all', '--live'], {
      PATH: hosts.path,
      TMPDIR: tmpRoot,
    });

    expect(result.code, result.stderr).toBe(0);
    const report = parse(result);
    expect(report.matrix.map((entry) => entry.host).sort()).toEqual(['claude', 'codex', 'opencode']);
    for (const entry of report.matrix) {
      expect(entry.status, entry.reason).toBe('PASS');
      expect(entry.live.attempted).toBe(true);
      expect(entry.live.exit_code).toBe(0);
      expect(entry.live.marker_found).toBe(true);
      expect(entry.static_checks.length).toBeGreaterThan(0);
    }
    expect(report.retained).toBeUndefined();
    const names = (await hosts.calls()).map((call) => call.name);
    expect(names).toEqual(expect.arrayContaining(['codex', 'claude', 'opencode']));
  });

  it('reports not_attempted and never PASS without --live', async () => {
    const hosts = await fake();
    const tmpRoot = await temp('ai-workflow-smoke-cli-tmp-');

    const result = await runCli(['host', 'smoke', '--host', 'all'], {
      PATH: hosts.path,
      TMPDIR: tmpRoot,
    });

    expect(result.code, result.stderr).toBe(0);
    const report = parse(result);
    expect(report.matrix).toHaveLength(3);
    for (const entry of report.matrix) {
      nonPass(entry);
      expect(entry.live.attempted).toBe(false);
      expect(entry.reason).toMatch(/not[ _]attempted/i);
    }
    expect(await hosts.calls()).toEqual([]);
  });

  it('exits 0 for a completed matrix containing UNVERIFIED or BLOCKED entries', async () => {
    const hosts = await fake({
      codex: { mode: 'fail', exitCode: 6, stderr: 'authentication required' },
      claude: { mode: 'nomarker' },
      opencode: { mode: 'ok' },
    });
    const tmpRoot = await temp('ai-workflow-smoke-cli-tmp-');

    const result = await runCli(['host', 'smoke', '--host', 'all', '--live'], {
      PATH: hosts.path,
      TMPDIR: tmpRoot,
    });

    expect(result.code, result.stderr).toBe(0);
    const report = parse(result);
    const codex = report.matrix.find((entry) => entry.host === 'codex');
    const claude = report.matrix.find((entry) => entry.host === 'claude');
    const opencode = report.matrix.find((entry) => entry.host === 'opencode');
    expect(codex).toBeDefined();
    expect(claude).toBeDefined();
    expect(opencode).toBeDefined();
    if (!codex || !claude || !opencode) throw new Error('missing host entry');
    nonPass(codex);
    expect(codex.live.exit_code).toBe(6);
    expect(codex.reason).toMatch(/authentication/i);
    nonPass(claude);
    expect(claude.live.exit_code).toBe(0);
    expect(claude.live.marker_found).toBe(false);
    expect(opencode.status, opencode.reason).toBe('PASS');
  });

  it('refuses a non-empty --home before any write and exits 1', async () => {
    const hosts = await fake();
    const tmpRoot = await temp('ai-workflow-smoke-cli-tmp-');
    const home = await temp('ai-workflow-smoke-cli-non-empty-');
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'keep.txt'), 'user data\n');
    const before = await snapshotTree(home);

    const result = await runCli(['host', 'smoke', '--host', 'codex', '--home', home], {
      PATH: hosts.path,
      TMPDIR: tmpRoot,
    });

    expect(result.stderr).not.toMatch(/unknown command/i);
    expect(result.code).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/empty|non-empty|home/i);
    expect(changedPaths(before, await snapshotTree(home))).toEqual([]);
    expect(await hosts.calls()).toEqual([]);
  });

  it('refuses a --home equal to or inside the real HOME and exits 1', async () => {
    const hosts = await fake();
    const tmpRoot = await temp('ai-workflow-smoke-cli-tmp-');
    const nested = join(homedir(), `.ai-workflow-smoke-refusal-${randomUUID()}`);

    const result = await runCli(['host', 'smoke', '--host', 'codex', '--home', nested], {
      PATH: hosts.path,
      TMPDIR: tmpRoot,
    });

    expect(result.stderr).not.toMatch(/unknown command/i);
    expect(result.code).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/home/i);
    expect(await exists(nested)).toBe(false);
    expect(await hosts.calls()).toEqual([]);
  });

  it('exits 1 when the installation HOME is not a directory', async () => {
    const hosts = await fake();
    const tmpRoot = await temp('ai-workflow-smoke-cli-tmp-');
    const notDirectory = join(await temp('ai-workflow-smoke-cli-file-'), 'home');
    await writeFile(notDirectory, 'not a directory\n');
    const before = await snapshotTree(join(notDirectory, '..'));

    const result = await runCli(['host', 'smoke', '--host', 'codex', '--home', notDirectory], {
      PATH: hosts.path,
      TMPDIR: tmpRoot,
    });

    expect(result.stderr).not.toMatch(/unknown command/i);
    expect(result.code).toBe(1);
    expect(changedPaths(before, await snapshotTree(join(notDirectory, '..')))).toEqual([]);
  });

  it('reports both absolute retained paths with --keep', async () => {
    const hosts = await fake();
    const tmpRoot = await temp('ai-workflow-smoke-cli-tmp-');
    const parent = await temp('ai-workflow-smoke-cli-home-parent-');
    const home = join(parent, 'home');

    const result = await runCli(['host', 'smoke', '--host', 'codex', '--home', home, '--keep'], {
      PATH: hosts.path,
      TMPDIR: tmpRoot,
    });

    expect(result.code, result.stderr).toBe(0);
    const retained = parse(result).retained;
    expect(retained).toBeDefined();
    if (!retained) throw new Error('expected retained paths');
    expect(retained.home).toBe(resolve(home));
    expect(isAbsolute(retained.home)).toBe(true);
    expect(isAbsolute(retained.fixture)).toBe(true);
    expect(await exists(retained.home)).toBe(true);
    expect(await exists(retained.fixture)).toBe(true);
    const relation = relative(retained.home, retained.fixture);
    expect(relation.startsWith('..') || isAbsolute(relation), 'fixture must be outside HOME').toBe(true);
  });

  it('removes an absent --home when --keep is absent', async () => {
    const hosts = await fake();
    const tmpRoot = await temp('ai-workflow-smoke-cli-tmp-');
    const parent = await temp('ai-workflow-smoke-cli-home-parent-');
    const home = join(parent, 'home');

    const result = await runCli(['host', 'smoke', '--host', 'codex', '--home', home], {
      PATH: hosts.path,
      TMPDIR: tmpRoot,
    });

    expect(result.code, result.stderr).toBe(0);
    expect(parse(result).retained).toBeUndefined();
    expect(await exists(home)).toBe(false);
    expect(await readdir(home).catch(() => [])).toEqual([]);
  });
});
