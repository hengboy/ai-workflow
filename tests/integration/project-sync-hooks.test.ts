import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SyncReport } from '../../src/sync/index.js';
import type { ProjectGateResult } from '../../src/sync/gate.js';
import { install } from '../../src/install/index.js';
import { exists } from '../../src/utils/fs.js';
import { packagePath } from '../../src/utils/schema.js';
import { changedPaths, snapshotTree, temporary, withGitShim, writeGitFixture, writeGitShim } from '../helpers.js';

/**
 * Frozen single-start synchronization cadence for `src/cli.ts` / `src/sync/gate.ts` (plan
 * `20261009-sync-once-at-skill-start`, Step 2).
 *
 * Command:
 *   node src/cli.ts sync-hook --host <claude|codex|opencode> [--phase] [--project <actual-root>]
 * Reads exactly one native JSON object from stdin (unless `--phase` is given).
 *
 * The single automatic trigger is the phase form. It always prints the raw gate JSON
 * (`decision`, `project`, `context`, optional `authority` and `report`) for every host. Every
 * native stdin event reads the stored per-actual-root result and issues zero source requests;
 * a missing stored result is a `allow` without a nested report whose context states that no
 * check has run. A stored `deny` (conflict) never clears on a native event or on an exemption.
 *
 * Output:
 *   - claude/codex native JSON, always exit 0:
 *       allow  -> { systemMessage?, hookSpecificOutput: { hookEventName, additionalContext? } }
 *       block  -> { hookSpecificOutput: { hookEventName, permissionDecision: 'deny',
 *                                         permissionDecisionReason: <reason> } }
 *       UserPromptSubmit deny -> { systemMessage, decision: 'block', reason, hookSpecificOutput }
 *     A CLI warning must never surface as an exit 2 denial or a permissionDecision deny.
 *   - opencode -> the raw ProjectGateResult JSON (plugin consumer) with exit 0.
 *
 * The OpenCode plugin boundary is driven by the INSTALLED plugin, which spawns the built
 * `dist/cli.js`; caches there are primed through the same phase form with the same fixture
 * environment.
 */
interface HookGateResult extends ProjectGateResult {
  project: string;
}

interface NativeOutput {
  systemMessage?: string;
  decision?: string;
  reason?: string;
  hookSpecificOutput?: {
    hookEventName?: string;
    additionalContext?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
}

interface HookProcessResult { code: number; stdout: string; stderr: string }

const repoRoot = process.cwd();
const tsxLoader = pathToFileURL(join(repoRoot, 'node_modules/tsx/dist/loader.mjs')).href;
const cliEntry = join(repoRoot, 'src/cli.ts');
const builtCli = packagePath('dist', 'cli.js');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Legacy section-comment syntax: a generated target carrying it is refused, never merged. */
function legacyMarker(id: string, body: string): string {
  return `<!-- ai-workflow:section ${id}:begin -->\n${body}\n<!-- ai-workflow:section ${id}:end -->\n`;
}

const navigationJson = `${JSON.stringify({ version: 1, module_roots: [], features: [] }, null, 2)}\n`;
const manifestJson = '{\n  "version": 1,\n  "files": {}\n}\n';

// Exactly the five generated documents, each a complete markerless Markdown file.
const baseSourceFiles: Record<string, string> = {
  'templates/project/AGENTS.md': '# Project contract\n\nFresh shared context. Adopted project guidance.\n',
  'templates/project/notes/AGENTS.md': '# Notes governance\n\nFresh notes governance.\n',
  'templates/project/notes/README.md': '# Notes readme\n\nFresh notes readme.\n',
  'templates/project/notes/implemented/AGENTS.md': '# Implemented governance\n\nFresh implemented governance.\n',
  'templates/project/notes/archived/AGENTS.md': '# Archived governance\n\nFresh archived governance.\n',
};

// Adopted target: complete markerless documents whose older bytes differ from source, so a safe
// full-file replacement lands while project-owned bytes and frozen data survive.
const targetAgents = '# Project contract\n\nOld shared context.\ncustom trailing note\n';
const targetMemory = '# Project memory\n\nProject-specific standard body.\n';
const targetNotesGovernance = '# Notes governance\n\nOld notes governance.\n';
const targetNotesReadme = '# Notes readme\n\nOld notes readme.\n';
const targetImplementedGovernance = '# Implemented governance\n\nOld implemented governance.\n';
const targetArchivedGovernance = '# Archived governance\n\nOld archived governance.\n';
const legacyAgents = legacyMarker('shared-context', 'Old shared context that must be replaced manually.');
const planSpecBytes = '# Frozen plan\n\nIndependent frozen plan bytes.\n';

interface GitFixture { binDirectory: string; fixturePath: string }

/** Plant the fake `git` earlier in PATH and the fixture file it reads, for one test run. */
async function gitFixture(files: Record<string, string>, fail?: string): Promise<GitFixture> {
  const binDirectory = await writeGitShim();
  const fixtureDirectory = await temporary('ai-workflow-sync-hook-fixture-');
  roots.push(binDirectory, fixtureDirectory);
  const fixturePath = await writeGitFixture(fixtureDirectory, { files, ...(fail === undefined ? {} : { fail }) });
  return { binDirectory, fixturePath };
}

async function adoptedProject(overrides: Record<string, string> = {}): Promise<string> {
  const root = await temporary('ai-workflow-sync-hook-');
  roots.push(root);
  await mkdir(join(root, '.ai-workflow/index'), { recursive: true });
  await mkdir(join(root, '.ai-workflow/plans/20260101-custom'), { recursive: true });
  await mkdir(join(root, '.ai-workflow/notes/implemented/feature'), { recursive: true });
  await mkdir(join(root, '.ai-workflow/notes/archived'), { recursive: true });
  const files: Record<string, string> = {
    '.ai-workflow/AGENTS.md': targetAgents,
    'MEMORY.md': targetMemory,
    '.ai-workflow/index/navigation.json': navigationJson,
    '.ai-workflow/index/navigation.md': '# Navigation\n\nAdopted navigation.\n',
    '.ai-workflow/notes/AGENTS.md': targetNotesGovernance,
    '.ai-workflow/notes/README.md': targetNotesReadme,
    '.ai-workflow/notes/implemented/AGENTS.md': targetImplementedGovernance,
    '.ai-workflow/notes/archived/AGENTS.md': targetArchivedGovernance,
    '.ai-workflow/notes/archived/manifest.json': manifestJson,
    '.ai-workflow/plans/20260101-custom/spec.md': planSpecBytes,
    ...overrides,
  };
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  await writeFile(join(root, '.gitignore'), '.ai-workflow/plans/\n.worktrees/\n');
  return root;
}

interface HookFixtureEnvironment {
  home: string;
  temporaryDirectory: string;
  head?: string;
  log?: string;
}

function subprocessEnv(fixture: HookFixtureEnvironment, git: GitFixture): NodeJS.ProcessEnv {
  return withGitShim({
    ...process.env,
    HOME: fixture.home,
    TMPDIR: fixture.temporaryDirectory,
    ...(fixture.head === undefined ? {} : { AI_WORKFLOW_FIXTURE_HEAD: fixture.head }),
    ...(fixture.log === undefined ? {} : { AI_WORKFLOW_FIXTURE_LOG: fixture.log }),
  }, git.binDirectory, git.fixturePath);
}

/** The shim `PATH` and fixture entries to place into the process environment for built hooks. */
function processShimEnv(git: GitFixture): Record<string, string> {
  return { PATH: `${git.binDirectory}${delimiter}${process.env.PATH ?? ''}`, AI_WORKFLOW_GIT_FIXTURE: git.fixturePath };
}

/** Run the worktree `src/cli.ts` through tsx (source gate), with the fake `git` on PATH. */
function runHook(args: string[], input: unknown, env: NodeJS.ProcessEnv): Promise<HookProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', tsxLoader, cliEntry, ...args],
      { cwd: repoRoot, env },
    );
    let stdout = '';
    let stderr = '';
    if (child.stdout) child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    if (child.stderr) child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', () => resolve({ code: 1, stdout, stderr }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (child.stdin) {
      if (input !== undefined) child.stdin.write(typeof input === 'string' ? input : JSON.stringify(input));
      child.stdin.end();
    }
  });
}

/**
 * Run the built `dist/cli.js` the installed OpenCode plugin actually spawns, inheriting the
 * surrounding fixture environment (the fake `git` on PATH, `HOME`, `TMPDIR`, fixture HEAD/log).
 */
function runBuiltHook(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<HookProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [builtCli, ...args], { cwd: repoRoot, env });
    let stdout = '';
    let stderr = '';
    if (child.stdout) child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    if (child.stderr) child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', () => resolve({ code: 1, stdout, stderr }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (child.stdin) child.stdin.end();
  });
}

function nativeInput(event: string, cwd: string, sessionId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cwd,
    session_id: sessionId,
    hook_event_name: event,
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    ...extra,
  };
}

function nativeContext(output: NativeOutput): string {
  return [output.systemMessage, output.hookSpecificOutput?.additionalContext]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
}

async function observedHeads(log: string): Promise<string[]> {
  try {
    return (await readFile(log, 'utf8')).split('\n').filter((line) => line.length > 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function hookFixture(): Promise<{ home: string; temporaryDirectory: string; log: string }> {
  const home = await temporary('ai-workflow-sync-hook-home-');
  const temporaryDirectory = await temporary('ai-workflow-sync-hook-tmp-');
  const logDirectory = await temporary('ai-workflow-sync-hook-log-');
  roots.push(home, temporaryDirectory, logDirectory);
  return { home, temporaryDirectory, log: join(logDirectory, 'heads.log') };
}

function expectNoCheck(context: string): void {
  expect(context, 'the no-check context must state that no check has run').toMatch(/no[\s\S]{0,80}(check|synchroni)/i);
}

const metadataPaths = ['.ai-workflow/sync.json', '.ai-workflow/project.yml', '.ai-workflow/.sync', '.ai-workflow/phase.json'];

async function expectNoProjectMetadata(root: string): Promise<void> {
  for (const metadata of metadataPaths) {
    expect(await exists(join(root, metadata)), `${metadata} must not be created`).toBe(false);
  }
}

// --- Host-shape mapping over a primed cache -----------------------------------------

interface MappingCase {
  name: string;
  expectedStatus: SyncReport['status'];
  source?: Record<string, string>;
  target?: Record<string, string>;
  failing?: boolean;
  deny?: boolean;
  authority: boolean;
  contextIncludes: string[];
}

const mappingCases: MappingCase[] = [
  {
    name: 'synchronized allow with the current updated contract context',
    expectedStatus: 'synchronized',
    authority: true,
    contextIncludes: ['Managed workflow artifacts are current', 'Fresh shared context.'],
  },
  {
    name: 'unverified warning allows with visible context',
    expectedStatus: 'unverified',
    failing: true,
    authority: false,
    contextIncludes: ['unverified', 'Warning:'],
  },
  {
    name: 'conflict blocks with an explicit native denial',
    expectedStatus: 'conflict',
    target: { '.ai-workflow/AGENTS.md': legacyAgents },
    deny: true,
    authority: false,
    contextIncludes: ['conflict', 'Conflict:'],
  },
];

const hosts = ['claude', 'codex', 'opencode'] as const;

describe('project sync hook adapter', () => {
  it.each(hosts.flatMap((host) => mappingCases.map((testCase) => ({ host, ...testCase }))))(
    'AC-007/AC-012: $host maps $name from the primed cache without a source request',
    async ({ host, ...testCase }) => {
      const project = await adoptedProject(testCase.target);
      const git = await gitFixture(testCase.source ?? baseSourceFiles, testCase.failing ? 'rate limited' : undefined);
      const fixture = await hookFixture();

      // Prime the actual-root cache through the real phase form at head A. It always prints
      // the raw gate JSON for every host and is the only event that contacts the source.
      const prime = await runHook(
        ['sync-hook', '--host', host, '--phase', '--project', project],
        undefined,
        subprocessEnv({ ...fixture, head: A, log: fixture.log }, git),
      );
      expect(prime.code, prime.stderr).toBe(0);
      const primed = JSON.parse(prime.stdout) as HookGateResult;
      expect(primed.decision).toBe(testCase.deny ? 'deny' : 'allow');
      expect(primed.report?.status).toBe(testCase.expectedStatus);
      expect(primed.project).toBe(project);
      for (const text of testCase.contextIncludes) expect(primed.context, 'prime context').toContain(text);
      expect(await observedHeads(fixture.log), 'only the phase entry may query the source').toEqual([A]);

      const afterPrime = await snapshotTree(project);

      // The native PreToolUse at head B replays the stored A result; it must never query the
      // source even though the branch answer would now differ.
      const native = await runHook(
        ['sync-hook', '--host', host],
        nativeInput('PreToolUse', project, 'map-session'),
        subprocessEnv({ ...fixture, head: B, log: fixture.log }, git),
      );
      expect(native.code, `stderr: ${native.stderr}`).toBe(0);

      if (host === 'opencode') {
        const gate = JSON.parse(native.stdout) as HookGateResult;
        expect(gate.decision).toBe(testCase.deny ? 'deny' : 'allow');
        expect(gate.project).toBe(project);
        expect(gate.report?.status).toBe(testCase.expectedStatus);
        for (const text of testCase.contextIncludes) expect(gate.context, 'replayed context').toContain(text);
        if (testCase.authority) expect(typeof gate.authority).toBe('string');
        else expect(gate.authority).toBeUndefined();
      } else {
        const output = JSON.parse(native.stdout) as NativeOutput;
        const context = nativeContext(output);
        expect(context.length).toBeGreaterThan(0);
        for (const text of testCase.contextIncludes) expect(context, 'replayed context').toContain(text);
        expect(output.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
        if (testCase.deny) {
          // A blocking report must not become an exit 2 denial: it uses the explicit shape.
          expect(output.hookSpecificOutput?.permissionDecision).toBe('deny');
          expect(output.hookSpecificOutput?.permissionDecisionReason ?? '').not.toBe('');
        } else {
          // Warning continuation stays normal and never accidentally denies.
          expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
        }
      }

      // The deny case also exercises the UserPromptSubmit block shape (still replaying A).
      if (testCase.deny) {
        const prompt = await runHook(
          ['sync-hook', '--host', host],
          nativeInput('UserPromptSubmit', project, 'map-session', { prompt: 'continue' }),
          subprocessEnv({ ...fixture, head: B, log: fixture.log }, git),
        );
        expect(prompt.code, prompt.stderr).toBe(0);
        if (host === 'opencode') {
          expect((JSON.parse(prompt.stdout) as HookGateResult).decision).toBe('deny');
        } else {
          const promptOutput = JSON.parse(prompt.stdout) as NativeOutput;
          expect(promptOutput.decision).toBe('block');
          expect(promptOutput.reason ?? '').not.toBe('');
          expect(promptOutput.reason ?? '').toContain('conflict');
          expect(promptOutput.hookSpecificOutput?.permissionDecision).toBeUndefined();
        }
      }

      expect(await observedHeads(fixture.log), 'native replay never queries the source').toEqual([A]);
      expect(changedPaths(afterPrime, await snapshotTree(project)), 'a native replay must not publish').toEqual([]);
      await expectNoProjectMetadata(project);
    },
    60_000,
  );

  it('AC-001/AC-002/AC-004: native events replay the stored result per actual root and never synchronize', async () => {
    const projectA = await adoptedProject();
    const projectB = await adoptedProject();
    const git = await gitFixture(baseSourceFiles);
    const fixture = await hookFixture();
    const envFor = (head: string) => subprocessEnv({ ...fixture, head, log: fixture.log }, git);
    const beforeA = await snapshotTree(projectA);

    // (a) A native PreToolUse with no stored check is an allow with a visible no-check
    // context, no denial, no source request and no project write, for claude and codex.
    for (const host of ['claude', 'codex'] as const) {
      const noCheck = await runHook(['sync-hook', '--host', host], nativeInput('PreToolUse', projectA, 'no-check'), envFor(B));
      expect(noCheck.code, noCheck.stderr).toBe(0);
      const output = JSON.parse(noCheck.stdout) as NativeOutput;
      expectNoCheck(nativeContext(output));
      expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
    }
    expect(await observedHeads(fixture.log), 'a native without a stored check must not query the source').toEqual([]);
    expect(changedPaths(beforeA, await snapshotTree(projectA)), 'a no-check native must not write the project').toEqual([]);

    // (b) The phase form at head A is the only source request and stores the raw result.
    const phaseA = await runHook(['sync-hook', '--host', 'claude', '--phase', '--project', projectA], undefined, envFor(A));
    expect(phaseA.code, phaseA.stderr).toBe(0);
    const storedA = JSON.parse(phaseA.stdout) as HookGateResult;
    expect(storedA.decision).toBe('allow');
    expect(storedA.project).toBe(projectA);
    expect(storedA.report?.source.commit).toBe(A);
    expect(await observedHeads(fixture.log)).toEqual([A]);

    // (c) Every native event at head B reuses A, including a resume SessionStart.
    const natives: Array<{ event: string; extra?: Record<string, unknown> }> = [
      { event: 'SessionStart', extra: { source: 'startup' } },
      { event: 'UserPromptSubmit', extra: { prompt: 'continue' } },
      { event: 'PreToolUse' },
      { event: 'SessionStart', extra: { source: 'resume' } },
    ];
    for (const native of natives) {
      const reply = await runHook(['sync-hook', '--host', 'claude'], nativeInput(native.event, projectA, 'S', native.extra), envFor(B));
      expect(reply.code, reply.stderr).toBe(0);
      const context = nativeContext(JSON.parse(reply.stdout) as NativeOutput);
      expect(context, `${native.event} must replay A`).toContain(A);
      expect(context, `${native.event} must not observe B`).not.toContain(B);
    }
    expect(await observedHeads(fixture.log), 'native events must reuse the stored entry').toEqual([A]);

    // (d) A second phase entry at B replaces the stored entry; natives then replay B.
    const phaseB = await runHook(['sync-hook', '--host', 'claude', '--phase', '--project', projectA], undefined, envFor(B));
    expect(phaseB.code, phaseB.stderr).toBe(0);
    expect((JSON.parse(phaseB.stdout) as HookGateResult).report?.source.commit).toBe(B);
    expect(await observedHeads(fixture.log)).toEqual([A, B]);

    const replayB = await runHook(['sync-hook', '--host', 'claude'], nativeInput('PreToolUse', projectA, 'S'), envFor(C));
    expect(replayB.code, replayB.stderr).toBe(0);
    const replayBContext = nativeContext(JSON.parse(replayB.stdout) as NativeOutput);
    expect(replayBContext).toContain(B);
    expect(replayBContext).not.toContain(C);
    expect(await observedHeads(fixture.log), 'the replaced entry must be served with zero requests').toEqual([A, B]);

    // (e) A distinct second actual root has no stored check: native is a no-check allow with
    // no request, and only its own phase entry synchronizes it.
    const beforeB = await snapshotTree(projectB);
    const noCheckB = await runHook(['sync-hook', '--host', 'claude'], nativeInput('PreToolUse', projectB, 'other-root'), envFor(C));
    expect(noCheckB.code, noCheckB.stderr).toBe(0);
    const noCheckBOutput = JSON.parse(noCheckB.stdout) as NativeOutput;
    expectNoCheck(nativeContext(noCheckBOutput));
    expect(noCheckBOutput.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(await observedHeads(fixture.log), 'an unprimed root must not query the source').toEqual([A, B]);
    expect(changedPaths(beforeB, await snapshotTree(projectB)), 'an unprimed root must not replay or write the first root').toEqual([]);

    const phaseC = await runHook(['sync-hook', '--host', 'claude', '--phase', '--project', projectB], undefined, envFor(C));
    expect(phaseC.code, phaseC.stderr).toBe(0);
    expect((JSON.parse(phaseC.stdout) as HookGateResult).report?.source.commit).toBe(C);
    expect(await observedHeads(fixture.log)).toEqual([A, B, C]);

    const replayA = await runHook(['sync-hook', '--host', 'claude'], nativeInput('PreToolUse', projectA, 'S'), envFor(D));
    expect(replayA.code, replayA.stderr).toBe(0);
    const replayAContext = nativeContext(JSON.parse(replayA.stdout) as NativeOutput);
    expect(replayAContext, 'the first root still replays its own stored B').toContain(B);
    expect(replayAContext).not.toContain(D);
    expect(await observedHeads(fixture.log), 'each actual root keeps its own cache entry').toEqual([A, B, C]);

    // (f) No project-local synchronization metadata anywhere.
    await expectNoProjectMetadata(projectA);
    await expectNoProjectMetadata(projectB);
    // Frozen plan bytes and independently owned data survive.
    for (const root of [projectA, projectB]) {
      expect(await readFile(join(root, '.ai-workflow/plans/20260101-custom/spec.md'), 'utf8')).toBe(planSpecBytes);
    }
  }, 90_000);

  it('AC-007: manual sync repairs files but never replaces the stored gate decision', async () => {
    const project = await adoptedProject();
    const git = await gitFixture(baseSourceFiles);
    const fixture = await hookFixture();
    const envFor = (head: string) => subprocessEnv({ ...fixture, head, log: fixture.log }, git);

    const prime = await runHook(['sync-hook', '--host', 'opencode', '--phase', '--project', project], undefined, envFor(A));
    expect(prime.code, prime.stderr).toBe(0);
    const stored = JSON.parse(prime.stdout) as HookGateResult;
    expect(stored.report?.source.commit).toBe(A);
    expect(await observedHeads(fixture.log)).toEqual([A]);

    // The manual command performs a fresh synchronization at B and prints the SyncReport.
    const manual = await runHook(['sync', project], undefined, envFor(B));
    expect(manual.code, manual.stderr).toBe(0);
    const manualReport = JSON.parse(manual.stdout) as SyncReport;
    expect(manualReport.status).toBe('synchronized');
    expect(manualReport.source.commit).toBe(B);
    expect(await observedHeads(fixture.log), 'manual sync is a fresh independent query').toEqual([A, B]);

    // A following native event still replays the STORED A decision with no new source request.
    const native = await runHook(['sync-hook', '--host', 'opencode'], nativeInput('PreToolUse', project, 'manual-session'), envFor(C));
    expect(native.code, native.stderr).toBe(0);
    const replayed = JSON.parse(native.stdout) as HookGateResult;
    expect(replayed.report?.source.commit, 'manual sync must not replace the stored gate decision').toBe(A);
    expect(replayed.context).toContain(A);
    expect(replayed.context).not.toContain(B);
    expect(await observedHeads(fixture.log), 'the native event after manual sync must issue zero requests').toEqual([A, B]);
  }, 60_000);
});

// --- OpenCode plugin boundary (installed plugin -> spawned dist CLI) ----------------

interface PluginSessionState { directory: string; parentID?: string }
interface PluginToast { title?: string; message?: string; variant?: string }
interface PluginSdk {
  sessions: Map<string, PluginSessionState>;
  toasts: PluginToast[];
  client: {
    session: { get: (input: { path: { id: string } }) => Promise<{ data: { id: string; directory: string; parentID?: string } | null }> };
    tui: { showToast: (input: { body: PluginToast }) => Promise<void> };
  };
}

/** Public external OpenCode SDK fixture: session.get reports the ACTUAL session directory. */
function pluginSdk(initial: Record<string, PluginSessionState>): PluginSdk {
  const sessions = new Map(Object.entries(initial));
  const toasts: PluginToast[] = [];
  return {
    sessions,
    toasts,
    client: {
      session: {
        get: async ({ path }) => {
          const state = sessions.get(path.id);
          return { data: state ? { id: path.id, directory: state.directory, ...(state.parentID === undefined ? {} : { parentID: state.parentID }) } : null };
        },
      },
      tui: { showToast: async ({ body }) => { toasts.push(body); } },
    },
  };
}

interface PluginHooks {
  'experimental.chat.system.transform': (input: { sessionID: string }, output: { system: string[] }) => Promise<void>;
  'tool.execute.before': (input: { sessionID: string; tool: string }, output: { args: Record<string, unknown> }) => Promise<void>;
  'tool.execute.after': (input: { sessionID: string; tool: string; args: Record<string, unknown> }) => Promise<void>;
}

const opencodePluginRelative = '.config/opencode/plugins/ai-workflow-sync.js';

async function loadInstalledPlugin(home: string, sdk: PluginSdk, contextDirectory: string): Promise<PluginHooks> {
  const pluginPath = join(home, opencodePluginRelative);
  const module = await import(pathToFileURL(pluginPath).href) as { AiWorkflowSyncPlugin: (input: { client: unknown; directory: string; worktree: string }) => Promise<PluginHooks> };
  return module.AiWorkflowSyncPlugin({ client: sdk.client, directory: contextDirectory, worktree: contextDirectory });
}

async function withProcessEnvironment<T>(values: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) { previous.set(key, process.env[key]); process.env[key] = value; }
  try { return await body(); } finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

/** Prime one actual root through the built phase form the installed plugin shares. */
async function primeBuilt(project: string, head: string): Promise<HookGateResult> {
  process.env.AI_WORKFLOW_FIXTURE_HEAD = head;
  const result = await runBuiltHook(['sync-hook', '--host', 'opencode', '--phase', '--project', project]);
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as HookGateResult;
}

describe('opencode plugin boundary', () => {
  it('REQ-004/AC-003/AC-004: injects the primed contract, serves an unprimed root with a no-check, then requires the primed contract read', async () => {
    const home = await temporary('ai-workflow-plugin-home-');
    const contextDirectory = await temporary('ai-workflow-plugin-context-');
    const fixtureLogDirectory = await temporary('ai-workflow-plugin-log-');
    const rootA = await adoptedProject();
    const rootBAgents = '# root B contract\n\nOld root B shared context.\n';
    const rootB = await adoptedProject({ '.ai-workflow/AGENTS.md': rootBAgents });
    roots.push(home, contextDirectory, fixtureLogDirectory, rootA, rootB);
    expect(contextDirectory).not.toBe(rootA);

    const git = await gitFixture(baseSourceFiles);
    const log = join(fixtureLogDirectory, 'heads.log');
    await install(['opencode'], { home, opencodeVersion: 'v1' });
    const sdk = pluginSdk({ S: { directory: rootA } });
    const plugin = await loadInstalledPlugin(home, sdk, contextDirectory);
    const contextBefore = await snapshotTree(contextDirectory);
    const contractB = join(rootB, '.ai-workflow/AGENTS.md');

    await withProcessEnvironment({
      HOME: home,
      TMPDIR: fixtureLogDirectory,
      ...processShimEnv(git),
      AI_WORKFLOW_FIXTURE_HEAD: A,
      AI_WORKFLOW_FIXTURE_LOG: log,
    }, async () => {
      // Prime rootA at A. The plugin's first event (a synthesized SessionStart) must reuse it.
      const primedA = await primeBuilt(rootA, A);
      expect(primedA.report?.status).toBe('synchronized');
      expect(await observedHeads(log)).toEqual([A]);

      const injected = { system: [] as string[] };
      await plugin['experimental.chat.system.transform']({ sessionID: 'S' }, injected);
      expect(injected.system.join('\n'), 'the primed contract must be injected before ordinary work').toContain('Fresh shared context.');
      await plugin['tool.execute.before']({ sessionID: 'S', tool: 'bash' }, { args: { command: 'ls' } });
      expect(await observedHeads(log), 'a primed plugin session must not query the source').toEqual([A]);

      // The SDK session directory moves to an unprimed root: the ordinary tool proceeds with
      // the no-check context, writes nothing and issues no source request.
      sdk.sessions.set('S', { directory: rootB });
      const rootBBefore = await snapshotTree(rootB);
      const noCheck = { system: [] as string[] };
      await plugin['experimental.chat.system.transform']({ sessionID: 'S' }, noCheck);
      expectNoCheck(noCheck.system.join('\n'));
      await plugin['tool.execute.before']({ sessionID: 'S', tool: 'bash' }, { args: { command: 'ls' } });
      expect(await observedHeads(log), 'an unprimed root must not query the source').toEqual([A]);
      expect(changedPaths(rootBBefore, await snapshotTree(rootB)), 'an unprimed root must stay unchanged').toEqual([]);

      // Prime rootB at B externally; the ordinary tool now rejects until rootB's contract is read.
      const primedB = await primeBuilt(rootB, B);
      expect(primedB.report?.status).toBe('synchronized');
      expect(await observedHeads(log)).toEqual([A, B]);
      process.env.AI_WORKFLOW_FIXTURE_HEAD = C;

      await expect(plugin['tool.execute.before']({ sessionID: 'S', tool: 'bash' }, { args: { command: 'ls' } }))
        .rejects.toThrow(/before ordinary project work continues/);

      await plugin['tool.execute.before']({ sessionID: 'S', tool: 'read' }, { args: { filePath: contractB } });
      await plugin['tool.execute.after']({ sessionID: 'S', tool: 'read', args: { filePath: contractB } });
      await plugin['tool.execute.before']({ sessionID: 'S', tool: 'bash' }, { args: { command: 'ls' } });

      // A child session on the same actual root reuses the stored result with no new HEAD query.
      sdk.sessions.set('P', { directory: rootB });
      sdk.sessions.set('C', { directory: rootB, parentID: 'P' });
      const parentOutput = { system: [] as string[] };
      await plugin['experimental.chat.system.transform']({ sessionID: 'P' }, parentOutput);
      expect(parentOutput.system.join('\n')).toContain('Fresh shared context.');
      const headsBeforeChild = await observedHeads(log);
      const childOutput = { system: [] as string[] };
      await plugin['experimental.chat.system.transform']({ sessionID: 'C' }, childOutput);
      expect(childOutput.system.join('\n'), 'a same-root child reuses the parent result').toBe(parentOutput.system.join('\n'));
      expect(await observedHeads(log), 'the reused result performs no new HEAD query').toEqual(headsBeforeChild);
    });

    expect(changedPaths(contextBefore, await snapshotTree(contextDirectory))).toEqual([]);
    for (const root of [rootA, rootB]) {
      expect(await readFile(join(root, '.ai-workflow/plans/20260101-custom/spec.md'), 'utf8')).toBe(planSpecBytes);
      await expectNoProjectMetadata(root);
    }
  }, 90_000);

  it('REQ-004/AC-003/AC-007: replays a stored conflict without clearing it on the exact actor and with no HEAD request', async () => {
    const home = await temporary('ai-workflow-plugin-conflict-home-');
    const contextDirectory = await temporary('ai-workflow-plugin-conflict-context-');
    const fixtureLogDirectory = await temporary('ai-workflow-plugin-conflict-log-');
    const rootA = await adoptedProject({ '.ai-workflow/AGENTS.md': legacyAgents });
    roots.push(home, contextDirectory, fixtureLogDirectory, rootA);

    const git = await gitFixture(baseSourceFiles);
    const log = join(fixtureLogDirectory, 'heads.log');
    await install(['opencode'], { home, opencodeVersion: 'v1' });
    const sdk = pluginSdk({ S: { directory: rootA } });
    const plugin = await loadInstalledPlugin(home, sdk, contextDirectory);
    const contextBefore = await snapshotTree(contextDirectory);

    await withProcessEnvironment({
      HOME: home,
      TMPDIR: fixtureLogDirectory,
      ...processShimEnv(git),
      AI_WORKFLOW_FIXTURE_HEAD: A,
      AI_WORKFLOW_FIXTURE_LOG: log,
    }, async () => {
      const primed = await primeBuilt(rootA, A);
      expect(primed.decision).toBe('deny');
      expect(primed.report?.status).toBe('conflict');
      expect(await observedHeads(log)).toEqual([A]);
      process.env.AI_WORKFLOW_FIXTURE_HEAD = B;

      const injected = { system: [] as string[] };
      await plugin['experimental.chat.system.transform']({ sessionID: 'S' }, injected);
      expect(injected.system.join('\n')).toContain('conflict');
      expect(sdk.toasts.some((toast) => toast.variant === 'error' && (toast.message ?? '').includes('conflict'))).toBe(true);

      // A malformed ownership target blocks the ordinary tool.
      await expect(plugin['tool.execute.before']({ sessionID: 'S', tool: 'bash' }, { args: { command: 'ls' } })).rejects.toThrow(/conflict/);

      // The exact sync actor is still permitted through the cached blocker, without clearing it.
      await plugin['tool.execute.before']({ sessionID: 'S', tool: 'bash' }, { args: { command: `ai-workflow sync ${rootA}` } });
      await expect(plugin['tool.execute.before']({ sessionID: 'S', tool: 'bash' }, { args: { command: 'ls' } })).rejects.toThrow(/conflict/);

      expect(await observedHeads(log), 'the cached conflict must never query the source').toEqual([A]);
    });

    expect(changedPaths(contextBefore, await snapshotTree(contextDirectory))).toEqual([]);
    expect(await readFile(join(rootA, '.ai-workflow/plans/20260101-custom/spec.md'), 'utf8')).toBe(planSpecBytes);
    await expectNoProjectMetadata(rootA);
  }, 90_000);

  it('REQ-004/AC-007: replays a stored source warning with visible context and no HEAD request', async () => {
    const home = await temporary('ai-workflow-plugin-warning-home-');
    const contextDirectory = await temporary('ai-workflow-plugin-warning-context-');
    const fixtureLogDirectory = await temporary('ai-workflow-plugin-warning-log-');
    const rootA = await adoptedProject();
    roots.push(home, contextDirectory, fixtureLogDirectory, rootA);

    const git = await gitFixture({}, 'rate limited');
    const log = join(fixtureLogDirectory, 'heads.log');
    await install(['opencode'], { home, opencodeVersion: 'v1' });
    const sdk = pluginSdk({ S: { directory: rootA } });
    const plugin = await loadInstalledPlugin(home, sdk, contextDirectory);
    const contextBefore = await snapshotTree(contextDirectory);

    await withProcessEnvironment({
      HOME: home,
      TMPDIR: fixtureLogDirectory,
      ...processShimEnv(git),
      AI_WORKFLOW_FIXTURE_HEAD: A,
      AI_WORKFLOW_FIXTURE_LOG: log,
    }, async () => {
      const primed = await primeBuilt(rootA, A);
      expect(primed.decision).toBe('allow');
      expect(primed.report?.status).toBe('unverified');
      expect(await observedHeads(log)).toEqual([A]);
      process.env.AI_WORKFLOW_FIXTURE_HEAD = B;

      const injected = { system: [] as string[] };
      await plugin['experimental.chat.system.transform']({ sessionID: 'S' }, injected);
      const context = injected.system.join('\n');
      expect(context).toContain('unverified');
      expect(context).not.toContain('current at');
      expect(sdk.toasts.some((toast) => toast.variant === 'warning')).toBe(true);

      expect(await observedHeads(log), 'the stored warning must never re-query the source').toEqual([A]);
    });

    expect(changedPaths(contextBefore, await snapshotTree(contextDirectory))).toEqual([]);
    expect(await readFile(join(rootA, '.ai-workflow/plans/20260101-custom/spec.md'), 'utf8')).toBe(planSpecBytes);
    await expectNoProjectMetadata(rootA);
  }, 90_000);

  it('REQ-003/AC-006: routes an explicit workdir to another adopted root from its own primed cache without changing the SDK session directory', async () => {
    const home = await temporary('ai-workflow-plugin-route-home-');
    const contextDirectory = await temporary('ai-workflow-plugin-route-context-');
    const fixtureLogDirectory = await temporary('ai-workflow-plugin-route-log-');
    const sessionRoot = await adoptedProject();
    const operationRootAgents = '# route B contract\n\nOld route B shared context.\n';
    const operationRoot = await adoptedProject({ '.ai-workflow/AGENTS.md': operationRootAgents });
    roots.push(home, contextDirectory, fixtureLogDirectory, sessionRoot, operationRoot);

    const git = await gitFixture(baseSourceFiles);
    const log = join(fixtureLogDirectory, 'heads.log');
    await install(['opencode'], { home, opencodeVersion: 'v1' });
    const sdk = pluginSdk({ S: { directory: sessionRoot } });
    const plugin = await loadInstalledPlugin(home, sdk, contextDirectory);
    const contextBefore = await snapshotTree(contextDirectory);

    await withProcessEnvironment({
      HOME: home,
      TMPDIR: fixtureLogDirectory,
      ...processShimEnv(git),
      AI_WORKFLOW_FIXTURE_HEAD: A,
      AI_WORKFLOW_FIXTURE_LOG: log,
    }, async () => {
      const operationContract = join(operationRoot, '.ai-workflow/AGENTS.md');

      await primeBuilt(sessionRoot, A);
      const primedOperation = await primeBuilt(operationRoot, B);
      expect(primedOperation.report?.status).toBe('synchronized');
      expect(await observedHeads(log)).toEqual([A, B]);
      process.env.AI_WORKFLOW_FIXTURE_HEAD = C;

      // The SDK session root injects its own primed contract and is not re-synchronized.
      const injected = { system: [] as string[] };
      await plugin['experimental.chat.system.transform']({ sessionID: 'S' }, injected);
      expect(injected.system.join('\n')).toContain('Fresh shared context.');
      const sessionRootAfterLoad = await snapshotTree(sessionRoot);

      // The ordinary Bash `workdir` reaches operationRoot's cached authority and refuses until
      // that root's contract is read, exactly as the current behavior requires.
      await expect(plugin['tool.execute.before']({ sessionID: 'S', tool: 'bash' }, { args: { command: 'ls', workdir: operationRoot } }))
        .rejects.toThrow(/before ordinary project work continues/);
      expect(await readFile(operationContract, 'utf8'), 'B must be primed before the operation').toContain('Fresh shared context.');

      await plugin['tool.execute.before']({ sessionID: 'S', tool: 'read' }, { args: { filePath: operationContract } });
      await plugin['tool.execute.after']({ sessionID: 'S', tool: 'read', args: { filePath: operationContract } });
      await plugin['tool.execute.before']({ sessionID: 'S', tool: 'bash' }, { args: { command: 'ls', workdir: operationRoot } });

      // No plugin event issued a source request, and the SDK session root stayed untouched.
      expect(await observedHeads(log), 'the plugin must answer from both primed caches').toEqual([A, B]);
      expect(changedPaths(sessionRootAfterLoad, await snapshotTree(sessionRoot)), 'the SDK session root must stay unchanged').toEqual([]);
    });

    expect(changedPaths(contextBefore, await snapshotTree(contextDirectory))).toEqual([]);
    for (const root of [sessionRoot, operationRoot]) {
      expect(await readFile(join(root, '.ai-workflow/plans/20260101-custom/spec.md'), 'utf8')).toBe(planSpecBytes);
      await expectNoProjectMetadata(root);
    }
  }, 90_000);
});
