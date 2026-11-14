import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { initializeProject, install } from '../../src/install/index.js';
import { runDoctor } from '../../src/ops/doctor.js';
import type { SyncReport } from '../../src/sync/index.js';
import type { Host } from '../../src/workflow/types.js';
import { changedPaths, frozenPlan, snapshotTree, temporary, workspacePlanFixture } from '../helpers.js';

/**
 * Doctor public contract (stable, minimal):
 *
 *   runDoctor(options: {
 *     project?: string;
 *     host?: Host;
 *     plan?: string;
 *     home?: string;
 *     runtimeDirectory?: string;
 *   }): Promise<{
 *     project: string | null;
 *     valid: boolean;   // true only when no check is 'fail'
 *     checks: Check[];
 *   }>
 *
 *   Check = {
 *     id: string;                              // stable across runs
 *     status: 'pass' | 'warn' | 'fail';
 *     detail: string;                          // a fault names the exact path, identity or SHA
 *     recovery?: string;                       // an exact command when one exists
 *   }
 *
 * Doctor is read-only: it never repairs, installs, trusts, restarts, stages or fetches.
 * The internal runtimeDirectory injection points at an isolated stored-gate directory;
 * the CLI uses the default runtime directory.
 */
interface Check { id: string; status: 'pass' | 'warn' | 'fail'; detail: string; recovery?: string }
interface DoctorReport { project: string | null; valid: boolean; checks: Check[] }

const projects: string[] = [];
const homes: string[] = [];
const temporaries: string[] = [];

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('doctor must not perform a network request');
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all([...projects, ...homes, ...temporaries].splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function healthyProject(): Promise<string> {
  const project = await temporary('ai-workflow-doctor-project-');
  projects.push(project);
  await initializeProject(project);
  return project;
}

async function installedHome(hosts: Host[] = ['claude']): Promise<string> {
  const home = await temporary('ai-workflow-doctor-home-');
  homes.push(home);
  await install(hosts, { home, opencodeVersion: 'v1' });
  return home;
}

async function runtimeDirectory(): Promise<string> {
  const directory = await temporary('ai-workflow-doctor-runtime-');
  temporaries.push(directory);
  return directory;
}

function storedCheckPath(runtime: string, host: Host, project: string): string {
  return join(runtime, host, `phase-${Buffer.from(project).toString('base64url')}.json`);
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

/** Write the exact stored gate result shape the synchronization gate persists. */
async function writeStoredCheck(runtime: string, project: string, host: Host): Promise<void> {
  const path = storedCheckPath(runtime, host, project);
  await mkdir(dirname(path), { recursive: true });
  const result = {
    decision: 'allow',
    project,
    report: healthySyncReport(project),
    context: `ai-workflow sync: synchronized\nProject: ${project}`,
  };
  await writeFile(path, `${JSON.stringify({ version: 1, unit: 'doctor-test', phase: true, result })}\n`);
}

async function healthyFixture(hosts: Host[] = ['claude']): Promise<{ project: string; home: string; runtime: string }> {
  const project = await healthyProject();
  const home = await installedHome(hosts);
  const runtime = await runtimeDirectory();
  for (const host of hosts) await writeStoredCheck(runtime, project, host);
  return { project, home, runtime };
}

function mentions(detail: string, absolute: string, relative?: string): boolean {
  return detail.includes(absolute) || (relative === undefined ? false : detail.includes(relative));
}

function nonPassCheck(report: DoctorReport, needles: string[], statuses?: Check['status'][]): Check | undefined {
  return report.checks.find((check) =>
    (statuses === undefined || statuses.includes(check.status))
    && needles.some((needle) => check.detail.includes(needle)),
  );
}

function expectRecovery(check: Check): void {
  expect(typeof check.recovery, `${check.id} must expose a recovery command`).toBe('string');
  expect(check.recovery?.length ?? 0).toBeGreaterThan(0);
}

describe('read-only doctor aggregate', () => {
  it('passes a healthy adopted project and healthy installation without writing project, HOME or runtime state', async () => {
    const { project, home, runtime } = await healthyFixture();
    const beforeProject = await snapshotTree(project);
    const beforeHome = await snapshotTree(home);
    const beforeRuntime = await snapshotTree(runtime);

    const report = await runDoctor({ project, home, runtimeDirectory: runtime });
    const second = await runDoctor({ project, home, runtimeDirectory: runtime });

    expect(report.project).toBe(project);
    expect(report.valid).toBe(true);
    expect(report.checks.length).toBeGreaterThan(0);
    expect(report.checks.every((check) => check.status === 'pass'), JSON.stringify(report.checks, null, 2)).toBe(true);
    const ids = report.checks.map((check) => check.id);
    expect(ids.every((id) => id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(second.checks.map((check) => check.id)).toEqual(ids);
    expect(changedPaths(beforeProject, await snapshotTree(project)), 'project must be unchanged').toEqual([]);
    expect(changedPaths(beforeHome, await snapshotTree(home)), 'HOME must be unchanged').toEqual([]);
    expect(changedPaths(beforeRuntime, await snapshotTree(runtime)), 'gate runtime directory must be unchanged').toEqual([]);
  });

  it('fails a missing contract with its exact path and a recovery command', async () => {
    const { project, home, runtime } = await healthyFixture();
    const relative = '.ai-workflow/AGENTS.md';
    await rm(join(project, relative));

    const report = await runDoctor({ project, home, runtimeDirectory: runtime });
    const check = nonPassCheck(report, [relative, join(project, relative)], ['fail']);

    expect(report.valid).toBe(false);
    expect(check, 'the missing contract must be reported').toBeDefined();
    expectRecovery(check!);
    expect(check!.recovery).toMatch(/init|sync/i);
  });

  it('fails a missing MEMORY.md with its exact path', async () => {
    const { project, home, runtime } = await healthyFixture();
    await rm(join(project, 'MEMORY.md'));

    const report = await runDoctor({ project, home, runtimeDirectory: runtime });
    const check = nonPassCheck(report, ['MEMORY.md', join(project, 'MEMORY.md')], ['fail']);

    expect(report.valid).toBe(false);
    expect(check).toBeDefined();
    expectRecovery(check!);
    expect(check!.recovery).toMatch(/init/i);
  });

  it('fails invalid navigation with its exact path', async () => {
    const { project, home, runtime } = await healthyFixture();
    const relative = '.ai-workflow/index/navigation.json';
    await writeFile(join(project, relative), '{ invalid navigation\n');

    const report = await runDoctor({ project, home, runtimeDirectory: runtime });
    const check = nonPassCheck(report, [relative, join(project, relative)], ['fail']);

    expect(report.valid).toBe(false);
    expect(check).toBeDefined();
    expectRecovery(check!);
    expect(check!.recovery).toMatch(/context/i);
  });

  it('fails a missing navigation Markdown view with its exact path while the JSON index stays valid', async () => {
    const { project, home, runtime } = await healthyFixture();
    const relative = '.ai-workflow/index/navigation.md';
    await rm(join(project, relative));

    const report = await runDoctor({ project, home, runtimeDirectory: runtime });
    const check = nonPassCheck(report, [relative, join(project, relative)], ['fail']);

    expect(report.valid).toBe(false);
    expect(check, 'the missing navigation view must be reported').toBeDefined();
    expectRecovery(check!);
    expect(check!.recovery).toMatch(/context/i);
  });

  it('fails failing notes with the exact required notes path', async () => {
    const { project, home, runtime } = await healthyFixture();
    const relative = '.ai-workflow/notes/AGENTS.md';
    await rm(join(project, relative));

    const report = await runDoctor({ project, home, runtimeDirectory: runtime });
    const check = nonPassCheck(report, [relative, join(project, relative)], ['fail']);

    expect(report.valid).toBe(false);
    expect(check).toBeDefined();
    expectRecovery(check!);
    expect(check!.recovery).toMatch(/notes/i);
  });

  it('fails an invalid --plan directory with its exact path', async () => {
    const { project, home, runtime } = await healthyFixture();
    const notAPlan = await temporary('ai-workflow-doctor-not-a-plan-');
    temporaries.push(notAPlan);

    const report = await runDoctor({ project, home, plan: notAPlan, runtimeDirectory: runtime });
    const check = nonPassCheck(report, [notAPlan], ['fail']);

    expect(report.valid).toBe(false);
    expect(check, 'the invalid plan directory must be reported').toBeDefined();
    expectRecovery(check!);
    expect(check!.recovery).toMatch(/plan validate/i);
  });

  it('fails a corrupted installation manifest without crashing', async () => {
    const { project, home, runtime } = await healthyFixture();
    const relative = '.config/ai-workflow/install-manifest.json';
    await writeFile(join(home, relative), '{ not json\n');

    const report = await runDoctor({ project, home, runtimeDirectory: runtime });
    const check = nonPassCheck(report, [relative, join(home, relative)]);

    expect(report.valid).toBe(false);
    expect(check, 'the corrupted installation record must be reported').toBeDefined();
    expect(['fail', 'warn']).toContain(check!.status);
    expectRecovery(check!);
    expect(check!.recovery).toMatch(/install/i);
  });

  it('warns about a mismatched shared-skill link with the exact path', async () => {
    const { project, home, runtime } = await healthyFixture();
    const other = await temporary('ai-workflow-doctor-other-skills-');
    temporaries.push(other);
    await mkdir(join(other, 'sync-ai-workflow'), { recursive: true });
    await writeFile(join(other, 'sync-ai-workflow', 'SKILL.md'), '# other skills\n');
    const relative = '.claude/skills';
    await rm(join(home, relative), { recursive: true, force: true });
    await symlink(other, join(home, relative), 'dir');

    const report = await runDoctor({ project, home, runtimeDirectory: runtime });
    const check = nonPassCheck(report, [relative, join(home, relative)]);

    expect(check, 'the mismatched shared-skill link must be reported').toBeDefined();
    expect(['fail', 'warn']).toContain(check!.status);
    expectRecovery(check!);
  });

  it('warns about a missing stored synchronization check with the exact phase command and no freshness claim', async () => {
    const { project, home, runtime } = await healthyFixture();
    const path = storedCheckPath(runtime, 'claude', project);
    await rm(path);
    const beforeRuntime = await snapshotTree(runtime);

    const report = await runDoctor({ project, home, runtimeDirectory: runtime });
    const check = report.checks.find((item) => item.status === 'warn' && /sync-hook/i.test(item.detail));

    expect(report.valid, 'a warning does not invalidate the report').toBe(true);
    expect(report.checks.some((item) => item.status === 'fail')).toBe(false);
    expect(check, 'the missing stored check must be a warning').toBeDefined();
    expect(check!.detail).toContain('--phase');
    expect(check!.detail).toContain('--project');
    expect(check!.detail).toContain(project);
    expect(check!.detail).not.toMatch(/artifacts are current|freshness is verified|up to date/i);
    expect(changedPaths(beforeRuntime, await snapshotTree(runtime)), 'doctor must not create a stored check').toEqual([]);
  });

  it('warns when host authentication or trust is unavailable, never passing it', async () => {
    const { project, home, runtime } = await healthyFixture(['claude']);
    const bin = await temporary('ai-workflow-doctor-bin-');
    temporaries.push(bin);
    const fakeClaude = join(bin, 'claude');
    await writeFile(fakeClaude, '#!/bin/sh\necho 1.0.0\n');
    await chmod(fakeClaude, 0o755);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);

    const report = await runDoctor({ project, home, host: 'claude', runtimeDirectory: runtime });
    const check = report.checks.find((item) =>
      item.status === 'warn'
      && /claude/i.test(item.detail)
      && /auth|trust|credential|login|executable|version/i.test(item.detail),
    );

    expect(check, 'missing authentication or trust must produce a host warning').toBeDefined();
    expect(check!.status).toBe('warn');
  });

  it('warns when a requested host executable is unavailable and never crashes', async () => {
    const { project, home, runtime } = await healthyFixture(['claude']);
    const emptyBin = await temporary('ai-workflow-doctor-empty-bin-');
    temporaries.push(emptyBin);
    vi.stubEnv('PATH', emptyBin);

    const report = await runDoctor({ project, home, host: 'claude', runtimeDirectory: runtime });
    const check = report.checks.find((item) => item.status === 'warn' && /claude/i.test(item.detail));

    expect(check, 'a missing host executable must be a warning').toBeDefined();
    expect(report.checks.some((item) => item.status === 'fail')).toBe(false);
  });

  it('skips unrequested uninstalled hosts while keeping every check passing', async () => {
    const { project, home, runtime } = await healthyFixture(['claude']);

    const report = await runDoctor({ project, home, runtimeDirectory: runtime });

    expect(report.valid).toBe(true);
    expect(report.checks.every((check) => check.status === 'pass')).toBe(true);
    expect(report.checks.filter((check) => check.status !== 'pass' && /codex|opencode/i.test(check.detail))).toEqual([]);
  });

  it('fails an explicitly requested uninstalled host with its install command', async () => {
    const { project, home, runtime } = await healthyFixture(['claude']);

    const report = await runDoctor({ project, home, host: 'codex', runtimeDirectory: runtime });
    const check = report.checks.find((item) =>
      item.status === 'fail'
      && (/codex/i.test(item.detail) || (item.recovery ?? '').includes('--host codex')),
    );

    expect(report.valid).toBe(false);
    expect(check, 'an explicitly requested uninstalled host must fail').toBeDefined();
    expectRecovery(check!);
    expect(check!.recovery).toContain('install');
    expect(check!.recovery).toContain('--host codex');
    expect(check!.recovery).toContain('--home');
    expect(check!.recovery).toContain(home);
  });

  it('rejects an invalid host before any check runs', async () => {
    const runtime = await runtimeDirectory();
    await expect(runDoctor({
      project: '/ai-workflow-does-not-exist/project',
      home: '/ai-workflow-does-not-exist/home',
      host: 'not-a-host' as Host,
      runtimeDirectory: runtime,
    })).rejects.toThrow(/Invalid host: not-a-host/i);
  });

  it('adds ordinary plan and workspace checks for --plan without weakening existing plan validation', async () => {
    const { project, home, runtime } = await healthyFixture();
    const ordinaryPlan = await frozenPlan(project, false);
    const base = await runDoctor({ project, home, runtimeDirectory: runtime });
    const withPlan = await runDoctor({ project, home, plan: ordinaryPlan, runtimeDirectory: runtime });

    expect(base.valid).toBe(true);
    expect(withPlan.valid).toBe(true);
    expect(withPlan.checks.length).toBeGreaterThan(base.checks.length);
    expect(withPlan.checks.every((check) => check.status === 'pass')).toBe(true);

    const workspacePlan = await workspacePlanFixture(project, {
      planId: '20260930-doctor-workspace',
      requirements: ['REQ-001'],
      acceptanceCriteria: ['AC-001'],
      workspaceRepos: [{ name: 'workspace', path: '.', dependsOn: [] }],
      tasks: [{ id: 'task-001-root', repo: 'workspace', requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'], writeScope: ['src/root.ts'] }],
      phases: [['task-001-root']],
      manifest: {
        planId: '20260930-doctor-workspace',
        role: 'workspace',
        repositories: [{ name: 'workspace', path: '.', dependsOn: [], requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'] }],
      },
    });
    const withWorkspace = await runDoctor({ project, home, plan: workspacePlan, runtimeDirectory: runtime });

    expect(withWorkspace.valid).toBe(true);
    expect(withWorkspace.checks.length).toBeGreaterThan(withPlan.checks.length);
    expect(withWorkspace.checks.every((check) => check.status === 'pass')).toBe(true);
    expect(withWorkspace.checks.some((check) => /workspace/i.test(`${check.id} ${check.detail}`))).toBe(true);
  });
});
