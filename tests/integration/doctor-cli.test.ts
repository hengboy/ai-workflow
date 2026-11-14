import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { initializeProject, install } from '../../src/install/index.js';
import type { SyncReport } from '../../src/sync/index.js';
import type { Host } from '../../src/workflow/types.js';
import { changedPaths, frozenPlan, snapshotTree, temporary } from '../helpers.js';

/**
 * CLI boundary for `ai-workflow doctor`:
 *
 *   doctor [--project <root>] [--host <host>] [--plan <dir>] [--home <path>] [--json]
 *
 * `--json` prints `{ project, valid, checks: [{ id, status, detail, recovery? }] }`.
 * Exit 0 = all pass, 2 = warnings only, 1 = any failure or invalid --host.
 * The default output is a human summary. Installation checks use `--home`.
 */
interface Check { id: string; status: 'pass' | 'warn' | 'fail'; detail: string; recovery?: string }
interface DoctorReport { project: string | null; valid: boolean; checks: Check[] }

const exec = promisify(execFile);
const cli = ['exec', 'tsx', 'src/cli.ts'] as const;

type CliResult = { code: number; stdout: string; stderr: string };

async function runCli(args: string[], options: { tempDirectory?: string } = {}): Promise<CliResult> {
  try {
    const { stdout, stderr } = await exec('pnpm', [...cli, ...args], {
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        ...(options.tempDirectory === undefined ? {} : { TMPDIR: options.tempDirectory }),
      },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failure.code === 'number' ? failure.code : 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

const projects: string[] = [];
const homes: string[] = [];
const temporaries: string[] = [];

afterEach(async () => {
  await Promise.all([...projects, ...homes, ...temporaries].splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function healthyProject(): Promise<string> {
  const project = await temporary('ai-workflow-doctor-cli-project-');
  projects.push(project);
  await initializeProject(project);
  return project;
}

async function installedHome(hosts: Host[] = ['claude']): Promise<string> {
  const home = await temporary('ai-workflow-doctor-cli-home-');
  homes.push(home);
  await install(hosts, { home, opencodeVersion: 'v1' });
  return home;
}

async function isolatedTmp(): Promise<string> {
  const directory = await temporary('ai-workflow-doctor-cli-tmp-');
  temporaries.push(directory);
  return directory;
}

function runtimeRoot(tempDirectory: string): string {
  return join(tempDirectory, 'ai-workflow', 'project-gate');
}

function storedCheckPath(tempDirectory: string, host: Host, project: string): string {
  return join(runtimeRoot(tempDirectory), host, `phase-${Buffer.from(project).toString('base64url')}.json`);
}

function healthySyncReport(project: string): SyncReport {
  return {
    project,
    source: { repository: 'hengboy/ai-workflow', branch: 'main', commit: 'a'.repeat(40) },
    status: 'synchronized',
    verified: true,
    proceed: true,
    check: false,
    created: [],
    updated: [],
    skipped: [],
    warnings: [],
    conflicts: [],
  };
}

async function writeStoredCheck(tempDirectory: string, project: string, host: Host): Promise<void> {
  const path = storedCheckPath(tempDirectory, host, project);
  await mkdir(dirname(path), { recursive: true });
  const result = {
    decision: 'allow',
    project,
    report: healthySyncReport(project),
    context: `ai-workflow sync: synchronized\nProject: ${project}`,
  };
  await writeFile(path, `${JSON.stringify({ version: 1, unit: 'doctor-cli-test', phase: true, result })}\n`);
}

function parseReport(result: CliResult): DoctorReport {
  return JSON.parse(result.stdout) as DoctorReport;
}

describe('doctor CLI', () => {
  it('reports a healthy adopted project with every check passing and no write', async () => {
    const project = await healthyProject();
    const home = await installedHome(['claude']);
    const tempDirectory = await isolatedTmp();
    await writeStoredCheck(tempDirectory, project, 'claude');
    const beforeProject = await snapshotTree(project);
    const beforeHome = await snapshotTree(home);
    const beforeRuntime = await snapshotTree(runtimeRoot(tempDirectory));

    const result = await runCli(['doctor', '--project', project, '--home', home, '--json'], { tempDirectory });

    expect(result.code, result.stderr).toBe(0);
    const report = parseReport(result);
    expect(report.project).toBe(project);
    expect(report.valid).toBe(true);
    expect(report.checks.length).toBeGreaterThan(0);
    expect(report.checks.every((check) => check.status === 'pass'), JSON.stringify(report.checks, null, 2)).toBe(true);
    const ids = report.checks.map((check) => check.id);
    expect(ids.every((id) => id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(changedPaths(beforeProject, await snapshotTree(project)), 'project must be unchanged').toEqual([]);
    expect(changedPaths(beforeHome, await snapshotTree(home)), 'HOME must be unchanged').toEqual([]);
    expect(changedPaths(beforeRuntime, await snapshotTree(runtimeRoot(tempDirectory))), 'gate runtime must be unchanged').toEqual([]);
  });

  it('prints a human summary by default and exits 1 for a failure', async () => {
    const project = await healthyProject();
    const home = await installedHome(['claude']);
    const tempDirectory = await isolatedTmp();
    await writeStoredCheck(tempDirectory, project, 'claude');
    await rm(join(project, '.ai-workflow/AGENTS.md'));

    const result = await runCli(['doctor', '--project', project, '--home', home], { tempDirectory });

    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/fail/i);
    expect(result.stdout).toContain('.ai-workflow/AGENTS.md');
  });

  it('exits 1 with an exact failing check for json failures', async () => {
    const project = await healthyProject();
    const home = await installedHome(['claude']);
    const tempDirectory = await isolatedTmp();
    await writeStoredCheck(tempDirectory, project, 'claude');
    await rm(join(project, '.ai-workflow/AGENTS.md'));

    const result = await runCli(['doctor', '--project', project, '--home', home, '--json'], { tempDirectory });

    expect(result.code).toBe(1);
    const report = parseReport(result);
    expect(report.valid).toBe(false);
    const check = report.checks.find((item) => item.status === 'fail' && /AGENTS\.md/.test(item.detail));
    expect(check).toBeDefined();
  });

  it('exits 2 for warnings only, including the exact missing stored-check phase command', async () => {
    const project = await healthyProject();
    const home = await installedHome(['claude']);
    const tempDirectory = await isolatedTmp();

    const result = await runCli(['doctor', '--project', project, '--home', home, '--json'], { tempDirectory });

    expect(result.code).toBe(2);
    const report = parseReport(result);
    expect(report.valid).toBe(true);
    expect(report.checks.some((check) => check.status === 'fail')).toBe(false);
    const warning = report.checks.find((check) => check.status === 'warn' && /sync-hook/i.test(check.detail));
    expect(warning).toBeDefined();
    expect(warning!.detail).toContain('--phase');
    expect(warning!.detail).toContain('--project');
    expect(warning!.detail).toContain(project);
    expect(warning!.detail).not.toMatch(/artifacts are current|freshness is verified|up to date/i);
  });

  it('rejects an invalid --host before any check runs', async () => {
    const project = await healthyProject();
    const home = await installedHome(['claude']);
    const tempDirectory = await isolatedTmp();

    const result = await runCli([
      'doctor',
      '--project', join(project, 'does-not-exist'),
      '--home', home,
      '--host', 'not-a-host',
      '--json',
    ], { tempDirectory });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Invalid host: not-a-host/i);
    expect(result.stderr).not.toContain('does-not-exist');
    expect(result.stdout.trim()).toBe('');
  });

  it('fails an explicitly requested uninstalled host with its install command', async () => {
    const project = await healthyProject();
    const home = await installedHome(['claude']);
    const tempDirectory = await isolatedTmp();
    await writeStoredCheck(tempDirectory, project, 'claude');

    const result = await runCli(['doctor', '--project', project, '--home', home, '--host', 'codex', '--json'], { tempDirectory });

    expect(result.code).toBe(1);
    const report = parseReport(result);
    expect(report.valid).toBe(false);
    const check = report.checks.find((item) => item.status === 'fail' && (/codex/i.test(item.detail) || (item.recovery ?? '').includes('--host codex')));
    expect(check).toBeDefined();
    expect(check!.recovery).toContain('install');
    expect(check!.recovery).toContain('--host codex');
    expect(check!.recovery).toContain('--home');
    expect(check!.recovery).toContain(home);
  });

  it('skips unrequested uninstalled hosts', async () => {
    const project = await healthyProject();
    const home = await installedHome(['claude']);
    const tempDirectory = await isolatedTmp();
    await writeStoredCheck(tempDirectory, project, 'claude');

    const result = await runCli(['doctor', '--project', project, '--home', home, '--json'], { tempDirectory });

    expect(result.code, result.stderr).toBe(0);
    const report = parseReport(result);
    expect(report.valid).toBe(true);
    expect(report.checks.every((check) => check.status === 'pass')).toBe(true);
    expect(report.checks.filter((check) => check.status !== 'pass' && /codex|opencode/i.test(check.detail))).toEqual([]);
  });

  it('uses --home as the installation root', async () => {
    const project = await healthyProject();
    const healthyHome = await installedHome(['claude']);
    const brokenHome = await installedHome(['claude']);
    const tempDirectory = await isolatedTmp();
    await writeStoredCheck(tempDirectory, project, 'claude');
    await writeFile(join(brokenHome, '.agents/skills/git-message/SKILL.md'), 'tampered managed skill\n');

    const healthy = await runCli(['doctor', '--project', project, '--home', healthyHome, '--json'], { tempDirectory });
    const broken = await runCli(['doctor', '--project', project, '--home', brokenHome, '--json'], { tempDirectory });

    expect(healthy.code, healthy.stderr).toBe(0);
    expect(parseReport(healthy).valid).toBe(true);
    expect(broken.code).toBe(1);
    const report = parseReport(broken);
    expect(report.valid).toBe(false);
    const check = report.checks.find((item) => item.status !== 'pass' && /git-message\/SKILL\.md/.test(item.detail));
    expect(check).toBeDefined();
  });

  it('adds plan checks for --plan while plan validate output stays unchanged', async () => {
    const project = await healthyProject();
    const home = await installedHome(['claude']);
    const tempDirectory = await isolatedTmp();
    await writeStoredCheck(tempDirectory, project, 'claude');
    const planDirectory = await frozenPlan(project, false);

    const before = await runCli(['plan', 'validate', '--plan', planDirectory]);
    const withoutPlan = await runCli(['doctor', '--project', project, '--home', home, '--json'], { tempDirectory });
    const withPlan = await runCli(['doctor', '--project', project, '--home', home, '--plan', planDirectory, '--json'], { tempDirectory });
    const after = await runCli(['plan', 'validate', '--plan', planDirectory]);

    expect(before.code, before.stderr).toBe(0);
    expect(withoutPlan.code, withoutPlan.stderr).toBe(0);
    expect(withPlan.code, withPlan.stderr).toBe(0);
    const base = parseReport(withoutPlan);
    const planned = parseReport(withPlan);
    expect(base.valid).toBe(true);
    expect(planned.valid).toBe(true);
    expect(planned.checks.length).toBeGreaterThan(base.checks.length);
    expect(planned.checks.every((check) => check.status === 'pass')).toBe(true);
    expect(planned.checks.some((check) => /plan/i.test(`${check.id} ${check.detail}`))).toBe(true);
    expect(after.code).toBe(0);
    expect(after.stdout).toBe(before.stdout);
  });
});
