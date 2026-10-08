import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SyncReport } from '../../src/sync/index.js';
import type { ProjectGateResult } from '../../src/sync/gate.js';
import { install } from '../../src/install/index.js';
import { exists } from '../../src/utils/fs.js';
import { changedPaths, snapshotTree, temporary } from '../helpers.js';

/**
 * Frozen native hook adapter contract for `src/cli.ts` slice 2.3.
 *
 * Command:
 *   node src/cli.ts sync-hook --host <claude|codex|opencode> [--phase] [--project <actual-root>]
 * Reads exactly one native JSON object from stdin (unless `--phase` is given).
 *
 * Native stdin fields (Claude/Codex common JSON):
 *   { cwd, session_id, hook_event_name, tool_name?, tool_input?, source?, prompt? }
 *   - hook_event_name: 'PreToolUse' | 'SessionStart' | 'UserPromptSubmit'
 *   - SessionStart carries `source` (e.g. 'resume'); UserPromptSubmit carries `prompt`.
 *
 * Output:
 *   - claude/codex native JSON, always exit 0:
 *       allow  -> { systemMessage?, hookSpecificOutput: { hookEventName, additionalContext? } }
 *       block  -> { hookSpecificOutput: { hookEventName, permissionDecision: 'deny',
 *                                         permissionDecisionReason: <reason> } }
 *     A CLI warning must never surface as an exit 2 denial or a permissionDecision deny.
 *   - opencode -> the raw ProjectGateResult JSON (plugin consumer) with exit 0.
 *   - `--phase --project <root>` -> the raw ProjectGateResult JSON for any host (cooperative
 *     explicit phase-entry bridge); a later same-root native session or child reuses it.
 *
 * The new required field `project` on ProjectGateResult is the normalized actual root; the
 * new optional input field `eventSource` carries `'resume'`.
 */
interface HookGateResult extends ProjectGateResult {
  project: string;
}

interface NativeOutput {
  systemMessage?: string;
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

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);
const E = 'e'.repeat(40);
const F = 'f'.repeat(40);
const G = '1'.repeat(40);

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function marker(id: string, body: string): string {
  return `<!-- ai-workflow:section ${id}:begin -->\n${body}\n<!-- ai-workflow:section ${id}:end -->\n`;
}

const navigationJson = `${JSON.stringify({ version: 1, module_roots: [], features: [] }, null, 2)}\n`;
const manifestJson = '{\n  "version": 1,\n  "files": {}\n}\n';
const notesGovernance = marker('notes-governance', 'Shared notes governance.');
const notesReadme = marker('notes-readme', 'Shared notes readme.');
const implementedGovernance = marker('implemented-governance', 'Shared implemented governance.');
const archivedGovernance = marker('archived-governance', 'Shared archived governance.');

const baseSourceFiles: Record<string, string> = {
  'templates/project/AGENTS.md': `# Project contract\n${marker('shared-context', '## Shared context\nFresh shared context.')}`,
  'templates/project/MEMORY.md': `# Project memory\n${marker('standards', 'Fresh standards.')}`,
  'templates/project/navigation.json': navigationJson,
  'templates/project/navigation.md': '# Navigation\n\nAdopted navigation.\n',
  'templates/project/notes/AGENTS.md': notesGovernance,
  'templates/project/notes/README.md': notesReadme,
  'templates/project/notes/implemented/AGENTS.md': implementedGovernance,
  'templates/project/notes/archived/AGENTS.md': archivedGovernance,
  'templates/project/notes/archived/manifest.json': manifestJson,
};

// A source MEMORY whose owned section body starts with a heading, so an unmarked target
// section with the same heading but different bytes becomes an unresolved attention warning.
const attentionSourceFiles: Record<string, string> = {
  ...baseSourceFiles,
  'templates/project/MEMORY.md': `# Project memory\n${marker('standards', '## Standards\nFresh standards.')}`,
};

const sourceDirectories: Record<string, readonly string[]> = {
  'templates/project': ['AGENTS.md', 'MEMORY.md', 'navigation.json', 'navigation.md', 'notes'],
  'templates/project/notes': ['AGENTS.md', 'README.md', 'implemented', 'archived'],
  'templates/project/notes/implemented': ['AGENTS.md'],
  'templates/project/notes/archived': ['AGENTS.md', 'manifest.json'],
};

// Adopted target: marked sections differ from source; custom bytes and independent data
// must survive a safe patch.
const targetAgents = `custom preface\n${marker('shared-context', '## Shared context\nOld shared context.')}custom suffix\n`;
const targetMemory = `# Project memory\n${marker('standards', 'Old standards.')}custom trailing note\n`;
const attentionTargetMemory = '# Project memory\n\n## Standards\nOld differing standard.\n';
const malformedAgents = `${marker('shared-context', 'one')}${marker('shared-context', 'two')}`;
const planSpecBytes = '# Frozen plan\n\nIndependent frozen plan bytes.\n';

function hookPreload(files: Record<string, string>): string {
  return `
import { appendFileSync } from 'node:fs';
const FILES = ${JSON.stringify(files)};
const DIRECTORIES = ${JSON.stringify(sourceDirectories)};
const COMMIT = process.env.AI_WORKFLOW_FIXTURE_HEAD || ${JSON.stringify(A)};
const LOG = process.env.AI_WORKFLOW_FIXTURE_LOG;
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const parsed = new URL(url);
  if (parsed.pathname === '/repos/hengboy/ai-workflow/branches/simplify') {
    if (LOG) appendFileSync(LOG, COMMIT + '\\n');
    return json({ name: 'simplify', commit: { sha: COMMIT } });
  }
  const prefix = '/repos/hengboy/ai-workflow/contents/';
  if (parsed.pathname.startsWith(prefix)) {
    const repoPath = decodeURIComponent(parsed.pathname.slice(prefix.length));
    const listing = DIRECTORIES[repoPath];
    if (listing) {
      return json(listing.map((name) => {
        const childPath = repoPath + '/' + name;
        return { type: childPath in DIRECTORIES ? 'dir' : 'file', name, path: childPath, sha: '0'.repeat(40), size: 10, url };
      }));
    }
    if (FILES[repoPath] !== undefined) {
      return json({ type: 'file', path: repoPath, sha: '0'.repeat(40), size: Buffer.byteLength(FILES[repoPath]), encoding: 'base64', content: Buffer.from(FILES[repoPath]).toString('base64') });
    }
  }
  return json({ message: 'Not Found' }, 404);
};
`;
}

function failingPreload(): string {
  return `
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const parsed = new URL(url);
  if (parsed.pathname === '/repos/hengboy/ai-workflow/branches/simplify') {
    return json({ message: 'rate limited' }, 403);
  }
  return json({ message: 'source unavailable' }, 503);
};
`;
}

async function writePreload(source: string, name = 'fixture.mjs'): Promise<string> {
  const directory = await temporary('ai-workflow-sync-hook-fixture-');
  roots.push(directory);
  const path = join(directory, name);
  await writeFile(path, source);
  return path;
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
    '.ai-workflow/notes/AGENTS.md': notesGovernance,
    '.ai-workflow/notes/README.md': notesReadme,
    '.ai-workflow/notes/implemented/AGENTS.md': implementedGovernance,
    '.ai-workflow/notes/archived/AGENTS.md': archivedGovernance,
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

function subprocessEnv(fixture: HookFixtureEnvironment): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: fixture.home,
    TMPDIR: fixture.temporaryDirectory,
    ...(fixture.head === undefined ? {} : { AI_WORKFLOW_FIXTURE_HEAD: fixture.head }),
    ...(fixture.log === undefined ? {} : { AI_WORKFLOW_FIXTURE_LOG: fixture.log }),
  };
}

function runHook(preloadPath: string, args: string[], input: unknown, env: NodeJS.ProcessEnv): Promise<HookProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', tsxLoader, '--import', pathToFileURL(preloadPath).href, cliEntry, ...args],
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

interface MappingCase {
  name: string;
  expectedStatus: SyncReport['status'];
  source?: Record<string, string>;
  target?: Record<string, string>;
  failing?: boolean;
  deny?: boolean;
  writesNothing?: boolean;
  contextIncludes?: string[];
}

const mappingCases: MappingCase[] = [
  {
    name: 'synchronized allow with the current updated contract context',
    expectedStatus: 'synchronized',
    contextIncludes: ['Managed workflow artifacts are current', 'Fresh shared context.'],
  },
  {
    name: 'unverified warning allows with visible context',
    expectedStatus: 'unverified',
    failing: true,
    writesNothing: true,
    contextIncludes: ['unverified'],
  },
  {
    name: 'needs_attention warning allows with visible context and fresh authority',
    expectedStatus: 'needs_attention',
    source: attentionSourceFiles,
    target: { 'MEMORY.md': attentionTargetMemory },
    contextIncludes: ['needs_attention', 'Fresh shared context.'],
  },
  {
    name: 'conflict blocks with an explicit native denial',
    expectedStatus: 'conflict',
    target: { '.ai-workflow/AGENTS.md': malformedAgents },
    deny: true,
    writesNothing: true,
  },
];

const hosts = ['claude', 'codex', 'opencode'] as const;

describe('project sync hook adapter', () => {
  it.each(hosts.flatMap((host) => mappingCases.map((testCase) => ({ host, ...testCase }))))(
    'AC-007/AC-012: $host maps $name',
    async (testCase) => {
      const project = await adoptedProject(testCase.target);
      const preloadPath = await writePreload(testCase.failing ? failingPreload() : hookPreload(testCase.source ?? baseSourceFiles));
      const fixture = await hookFixture();
      const before = await snapshotTree(project);

      const result = await runHook(
        preloadPath,
        ['sync-hook', '--host', testCase.host],
        nativeInput('PreToolUse', project, 'map-session'),
        subprocessEnv({ ...fixture, head: A, log: fixture.log }),
      );

      // Native hooks convey decisions in JSON; warning and block both exit normally.
      expect(result.code, `stderr: ${result.stderr}`).toBe(0);

      if (testCase.host === 'opencode') {
        const gate = JSON.parse(result.stdout) as HookGateResult;
        expect(gate.decision).toBe(testCase.deny ? 'deny' : 'allow');
        expect(gate.report?.status).toBe(testCase.expectedStatus);
        expect(gate.context.length).toBeGreaterThan(0);
        for (const text of testCase.contextIncludes ?? []) expect(gate.context).toContain(text);
      } else {
        const output = JSON.parse(result.stdout) as NativeOutput;
        const context = nativeContext(output);
        expect(context.length).toBeGreaterThan(0);
        for (const text of testCase.contextIncludes ?? []) expect(context).toContain(text);
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

      if (testCase.writesNothing) {
        expect(changedPaths(before, await snapshotTree(project)), 'warning/block must not publish').toEqual([]);
      }

      for (const metadata of ['.ai-workflow/sync.json', '.ai-workflow/project.yml', '.ai-workflow/.sync']) {
        expect(await exists(join(project, metadata)), `${metadata} must not be created`).toBe(false);
      }
    },
  );

  it('AC-006: persists one unit across native hook processes and shares an explicit phase bridge result', async () => {
    const project = await adoptedProject();
    const preloadPath = await writePreload(hookPreload(baseSourceFiles));
    const fixture = await hookFixture();
    const environmentFor = (head: string) => subprocessEnv({ ...fixture, head, log: fixture.log });
    const preloadBefore = await snapshotTree(project);

    // A new session begins a unit and synchronizes the current HEAD (A).
    const sessionStart = await runHook(preloadPath, ['sync-hook', '--host', 'claude'], nativeInput('SessionStart', project, 'S'), environmentFor(A));
    expect(sessionStart.code, sessionStart.stderr).toBe(0);
    expect(nativeContext(JSON.parse(sessionStart.stdout) as NativeOutput)).toContain(A);
    expect(await observedHeads(fixture.log)).toEqual([A]);

    // HEAD advances, but the same unit's tool call reuses A with no external HEAD query.
    const tool = await runHook(preloadPath, ['sync-hook', '--host', 'claude'], nativeInput('PreToolUse', project, 'S'), environmentFor(B));
    expect(tool.code, tool.stderr).toBe(0);
    const toolContext = nativeContext(JSON.parse(tool.stdout) as NativeOutput);
    expect(toolContext, 'no mid-unit rule change').toContain(A);
    expect(toolContext).not.toContain(B);
    expect(await observedHeads(fixture.log), 'a reused unit queries HEAD once').toEqual([A]);

    // A prompt event begins a new unit and picks up B.
    const prompt = await runHook(preloadPath, ['sync-hook', '--host', 'claude'], nativeInput('UserPromptSubmit', project, 'S', { prompt: 'continue' }), environmentFor(B));
    expect(prompt.code, prompt.stderr).toBe(0);
    expect(nativeContext(JSON.parse(prompt.stdout) as NativeOutput)).toContain(B);
    expect(await observedHeads(fixture.log)).toEqual([A, B]);

    // A resuming SessionStart invalidates the previous result and synchronizes C.
    const resume = await runHook(preloadPath, ['sync-hook', '--host', 'claude'], nativeInput('SessionStart', project, 'S', { source: 'resume' }), environmentFor(C));
    expect(resume.code, resume.stderr).toBe(0);
    expect(nativeContext(JSON.parse(resume.stdout) as NativeOutput)).toContain(C);
    expect(await observedHeads(fixture.log)).toEqual([A, B, C]);

    // A later tool call still reuses C even though HEAD advanced to D.
    const afterResume = await runHook(preloadPath, ['sync-hook', '--host', 'claude'], nativeInput('PreToolUse', project, 'S'), environmentFor(D));
    expect(afterResume.code, afterResume.stderr).toBe(0);
    const afterResumeContext = nativeContext(JSON.parse(afterResume.stdout) as NativeOutput);
    expect(afterResumeContext).toContain(C);
    expect(afterResumeContext).not.toContain(D);
    expect(await observedHeads(fixture.log)).toEqual([A, B, C]);

    // An explicit phase bridge begins a new unit on E and reports the raw GateResult.
    const phase = await runHook(preloadPath, ['sync-hook', '--host', 'claude', '--phase', '--project', project], undefined, environmentFor(E));
    expect(phase.code, phase.stderr).toBe(0);
    const phaseResult = JSON.parse(phase.stdout) as HookGateResult;
    expect(phaseResult.decision).toBe('allow');
    expect(phaseResult.project).toBe(project);
    expect(phaseResult.report?.source.commit).toBe(E);
    expect(await observedHeads(fixture.log)).toEqual([A, B, C, E]);

    // A same-root native session (a different session id) reuses the phase snapshot on F.
    const phaseChild = await runHook(preloadPath, ['sync-hook', '--host', 'claude'], nativeInput('PreToolUse', project, 'S2'), environmentFor(F));
    expect(phaseChild.code, phaseChild.stderr).toBe(0);
    const phaseChildContext = nativeContext(JSON.parse(phaseChild.stdout) as NativeOutput);
    expect(phaseChildContext, 'a same-root current session shares the phase result').toContain(E);
    expect(phaseChildContext).not.toContain(F);
    expect(await observedHeads(fixture.log)).toEqual([A, B, C, E]);

    // A second explicit phase entry begins a new unit and synchronizes G.
    const phaseAgain = await runHook(preloadPath, ['sync-hook', '--host', 'claude', '--phase', '--project', project], undefined, environmentFor(G));
    expect(phaseAgain.code, phaseAgain.stderr).toBe(0);
    expect((JSON.parse(phaseAgain.stdout) as HookGateResult).report?.source.commit).toBe(G);
    expect(await observedHeads(fixture.log)).toEqual([A, B, C, E, G]);

    // No root-local phase record, source baseline or synchronization metadata.
    for (const metadata of ['.ai-workflow/sync.json', '.ai-workflow/project.yml', '.ai-workflow/.sync', '.ai-workflow/phase.json']) {
      expect(await exists(join(project, metadata)), `${metadata} must not be created`).toBe(false);
    }
    // Managed safe patches are the only project change; no runtime state leaks in.
    expect(changedPaths(preloadBefore, await snapshotTree(project))).toEqual(['.ai-workflow/AGENTS.md', 'MEMORY.md']);
  }, 60_000);
});

// --- OpenCode plugin boundary (installed plugin -> real sync-hook CLI) -------------

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

async function loadInstalledPlugin(home: string, sdk: PluginSdk, contextDirectory: string): Promise<PluginHooks> {
  const pluginPath = join(home, '.config/opencode/plugins/ai-workflow-sync.js');
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

interface PluginBoundaryCase { name: string; kind: 'lifecycle' | 'conflict' | 'warning' }

const pluginBoundaryCases: PluginBoundaryCase[] = [
  { name: 'injects the fresh contract before tools and an explicit read resolves a pending authority after a root switch', kind: 'lifecycle' },
  { name: 'blocks an ordinary tool on a malformed target yet permits the exact sync actor through the cached blocker', kind: 'conflict' },
  { name: 'allows a source warning with visible context and no false freshness', kind: 'warning' },
];

describe('opencode plugin boundary', () => {
  it.each(pluginBoundaryCases)('REQ-004/AC-006/AC-007/AC-008: $name', async (testCase) => {
    const home = await temporary('ai-workflow-plugin-home-');
    const contextDirectory = await temporary('ai-workflow-plugin-context-');
    const fixtureLogDirectory = await temporary('ai-workflow-plugin-log-');
    const rootA = await adoptedProject(testCase.kind === 'conflict' ? { '.ai-workflow/AGENTS.md': malformedAgents } : {});
    // A separately adopted root with independently preserved custom contract bytes, so the
    // authority text genuinely differs when the actual SDK session directory changes.
    const rootBAgents = `# root B custom preface\n${marker('shared-context', '## Shared context\nOld shared context.')}root B suffix\n`;
    const rootB = await adoptedProject({ '.ai-workflow/AGENTS.md': rootBAgents });
    roots.push(home, contextDirectory, fixtureLogDirectory, rootA, rootB);
    expect(contextDirectory).not.toBe(rootA);

    const preloadPath = await writePreload(testCase.kind === 'warning' ? failingPreload() : hookPreload(baseSourceFiles));
    const log = join(fixtureLogDirectory, 'heads.log');
    await install(['opencode'], { home, opencodeVersion: 'v1' });
    const sdk = pluginSdk({ S: { directory: rootA }, P: { directory: rootA }, C: { directory: rootA, parentID: 'P' } });
    const plugin = await loadInstalledPlugin(home, sdk, contextDirectory);
    const contextBefore = await snapshotTree(contextDirectory);

    await withProcessEnvironment({
      HOME: home,
      TMPDIR: fixtureLogDirectory,
      NODE_OPTIONS: `--import ${pathToFileURL(preloadPath).href}`,
      AI_WORKFLOW_FIXTURE_HEAD: A,
      AI_WORKFLOW_FIXTURE_LOG: log,
    }, async () => {
      const contractB = join(rootB, '.ai-workflow/AGENTS.md');

      if (testCase.kind === 'lifecycle') {
        // system.transform synchronizes and injects the current updated contract before any tool.
        const injected = { system: [] as string[] };
        await plugin['experimental.chat.system.transform']({ sessionID: 'S' }, injected);
        expect(injected.system.join('\n'), 'the fresh contract must be injected before ordinary work').toContain('Fresh shared context.');

        // The ordinary tool is allowed from the cached snapshot.
        await plugin['tool.execute.before']({ sessionID: 'S', tool: 'bash' }, { args: { command: 'ls' } });

        // The ACTUAL SDK session directory changes to a separately adopted root: the ordinary
        // tool triggers a fresh sync and refuses until the authority is reloaded.
        sdk.sessions.set('S', { directory: rootB });
        await expect(plugin['tool.execute.before']({ sessionID: 'S', tool: 'bash' }, { args: { command: 'ls' } }))
          .rejects.toThrow(/before ordinary project work continues/);

        // The exact authority read of the new root is allowed even through the gate, and
        // simulating the public after hook records the read, resolving the pending authority.
        await plugin['tool.execute.before']({ sessionID: 'S', tool: 'read' }, { args: { filePath: contractB } });
        await plugin['tool.execute.after']({ sessionID: 'S', tool: 'read', args: { filePath: contractB } });
        await plugin['tool.execute.before']({ sessionID: 'S', tool: 'bash' }, { args: { command: 'ls' } });

        // A child on the same actual root reuses the parent snapshot (external HEAD evidence).
        const parentOutput = { system: [] as string[] };
        await plugin['experimental.chat.system.transform']({ sessionID: 'P' }, parentOutput);
        const headsAfterParent = await observedHeads(log);
        const childOutput = { system: [] as string[] };
        await plugin['experimental.chat.system.transform']({ sessionID: 'C' }, childOutput);
        expect(childOutput.system.join('\n'), 'a same-root child reuses the parent snapshot').toBe(parentOutput.system.join('\n'));
        expect(await observedHeads(log), 'the child reuse performs no new HEAD query').toEqual(headsAfterParent);
        return;
      }

      if (testCase.kind === 'conflict') {
        const injected = { system: [] as string[] };
        await plugin['experimental.chat.system.transform']({ sessionID: 'S' }, injected);
        expect(injected.system.join('\n')).toContain('conflict');
        expect(sdk.toasts.some((toast) => toast.variant === 'error' && (toast.message ?? '').includes('conflict'))).toBe(true);

        // A malformed ownership target blocks the ordinary tool.
        await expect(plugin['tool.execute.before']({ sessionID: 'S', tool: 'bash' }, { args: { command: 'ls' } })).rejects.toThrow(/conflict/);

        // The exact sync actor is still permitted through the cached blocker, without clearing it.
        await plugin['tool.execute.before']({ sessionID: 'S', tool: 'bash' }, { args: { command: `ai-workflow sync ${rootA}` } });
        await expect(plugin['tool.execute.before']({ sessionID: 'S', tool: 'bash' }, { args: { command: 'ls' } })).rejects.toThrow(/conflict/);
        return;
      }

      // Source warning: allowed with visible context and no false freshness claim.
      const injected = { system: [] as string[] };
      await plugin['experimental.chat.system.transform']({ sessionID: 'S' }, injected);
      const context = injected.system.join('\n');
      expect(context).toContain('unverified');
      expect(context).not.toContain('current at');
      expect(sdk.toasts.some((toast) => toast.variant === 'warning')).toBe(true);
    });

    // Unrelated context trees and frozen plan bytes stay unchanged in every branch.
    expect(changedPaths(contextBefore, await snapshotTree(contextDirectory))).toEqual([]);
    for (const root of [rootA, rootB]) {
      expect(await readFile(join(root, '.ai-workflow/plans/20260101-custom/spec.md'), 'utf8')).toBe(planSpecBytes);
    }
  }, 90_000);

  it('REQ-003/AC-006: routes an explicit workdir to another adopted root without changing the SDK session directory', async () => {
    const home = await temporary('ai-workflow-plugin-route-home-');
    const contextDirectory = await temporary('ai-workflow-plugin-route-context-');
    const fixtureLogDirectory = await temporary('ai-workflow-plugin-route-log-');
    const sessionRoot = await adoptedProject();
    // A separately adopted root with independently preserved custom bytes; the SDK session
    // directory stays at sessionRoot for the whole test.
    const operationRootAgents = `# route B custom preface\n${marker('shared-context', '## Shared context\nOld shared context.')}route B suffix\n`;
    const operationRoot = await adoptedProject({ '.ai-workflow/AGENTS.md': operationRootAgents });
    roots.push(home, contextDirectory, fixtureLogDirectory, sessionRoot, operationRoot);

    const preloadPath = await writePreload(hookPreload(baseSourceFiles));
    const log = join(fixtureLogDirectory, 'heads.log');
    await install(['opencode'], { home, opencodeVersion: 'v1' });
    const sdk = pluginSdk({ S: { directory: sessionRoot } });
    const plugin = await loadInstalledPlugin(home, sdk, contextDirectory);

    await withProcessEnvironment({
      HOME: home,
      TMPDIR: fixtureLogDirectory,
      NODE_OPTIONS: `--import ${pathToFileURL(preloadPath).href}`,
      AI_WORKFLOW_FIXTURE_HEAD: A,
      AI_WORKFLOW_FIXTURE_LOG: log,
    }, async () => {
      const operationContract = join(operationRoot, '.ai-workflow/AGENTS.md');

      // First load of the SDK session root A is allowed and injects A's contract.
      const injected = { system: [] as string[] };
      await plugin['experimental.chat.system.transform']({ sessionID: 'S' }, injected);
      expect(injected.system.join('\n')).toContain('Fresh shared context.');
      const sessionRootAfterLoad = await snapshotTree(sessionRoot);

      // An ordinary Bash `workdir` targets adopted root B: B synchronizes before the operation
      // and ordinary work is refused until B's authority is read.
      await expect(plugin['tool.execute.before']({ sessionID: 'S', tool: 'bash' }, { args: { command: 'ls', workdir: operationRoot } }))
        .rejects.toThrow(/before ordinary project work continues/);
      expect(await readFile(operationContract, 'utf8'), 'B must sync before the operation').toContain('Fresh shared context.');

      // The exact contract read of B is allowed even though the SDK session directory is still A,
      // and the public after hook must approve the current B pending authority.
      await plugin['tool.execute.before']({ sessionID: 'S', tool: 'read' }, { args: { filePath: operationContract } });
      await plugin['tool.execute.after']({ sessionID: 'S', tool: 'read', args: { filePath: operationContract } });

      // The ordinary Bash workdir B now proceeds: no stale A claim and no authority loop.
      await plugin['tool.execute.before']({ sessionID: 'S', tool: 'bash' }, { args: { command: 'ls', workdir: operationRoot } });

      // The routed operation never synchronizes or otherwise changes the SDK session root A.
      expect(changedPaths(sessionRootAfterLoad, await snapshotTree(sessionRoot)), 'the SDK session root must stay unchanged').toEqual([]);
    });
  }, 90_000);
});
