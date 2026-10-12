import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { access, chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { resolveTemplateSnapshot } from '../../src/sync/source.js';
import { temporary } from '../helpers.js';

const REPOSITORY = 'hengboy/ai-workflow';
const BRANCH = 'main';
const COMMIT = '7c0d9a3f2b1e4d5c6a7b8c9d0e1f2a3b4c5d6e7f';
const SYSTEM_PROXY_URL = 'http://127.0.0.1:7897';

/** The exactly-five generated members fixed by the sync allowlist. */
const GENERATED_SOURCES = [
  'templates/project/AGENTS.md',
  'templates/project/notes/AGENTS.md',
  'templates/project/notes/README.md',
  'templates/project/notes/implemented/AGENTS.md',
  'templates/project/notes/archived/AGENTS.md',
] as const;

/** Independently expected upstream bytes for one immutable commit. */
function expectedFiles(commit: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const path of GENERATED_SOURCES) {
    const name = path.slice('templates/project/'.length).replace(/\.md$/, '');
    files[path] = `# ${name}\n\nIndependent upstream body pinned at ${commit}.\n`;
  }
  return files;
}

// The proxy vars the default runner owns, plus the caller fields and fixture seams it must carry.
const MANAGED_ENV = [
  'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'http_proxy', 'HTTP_PROXY', 'no_proxy', 'NO_PROXY',
  'PATH', 'AI_WORKFLOW_FIXTURE_HEAD', 'AI_WORKFLOW_GIT_FIXTURE', 'AI_WORKFLOW_FIXTURE_RECEIVED',
  'AI_WORKFLOW_FIXTURE_SCUTIL', 'AI_WORKFLOW_FIXTURE_SCUTIL_FAIL', 'AI_WORKFLOW_FIXTURE_SCUTIL_LOG',
] as const;

// A real subprocess `git` shim on PATH. It records exactly which proxy variables the child
// received and only succeeds when the routing matches the fixture's declared expectation, so the
// URL scheme/host/port is validated at the boundary instead of by substring.
const GIT_NETWORK_SHIM = `#!/usr/bin/env node
const { mkdirSync, writeFileSync, readFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const args = process.argv.slice(2);
const observed = {
  https_proxy: process.env.https_proxy || '',
  HTTPS_PROXY: process.env.HTTPS_PROXY || '',
  all_proxy: process.env.all_proxy || '',
  ALL_PROXY: process.env.ALL_PROXY || '',
  no_proxy: process.env.no_proxy || '',
  NO_PROXY: process.env.NO_PROXY || '',
};
if (args[0] === 'clone') {
  if (process.env.AI_WORKFLOW_FIXTURE_RECEIVED) writeFileSync(process.env.AI_WORKFLOW_FIXTURE_RECEIVED, JSON.stringify(observed));
  const fixturePath = process.env.AI_WORKFLOW_GIT_FIXTURE;
  const fixture = fixturePath ? JSON.parse(readFileSync(fixturePath, 'utf8')) : { files: {} };
  const received = observed.https_proxy || observed.HTTPS_PROXY || observed.all_proxy || observed.ALL_PROXY || '';
  const expected = fixture.direct ? '' : (fixture.proxy || '');
  const routed = fixture.direct ? received === '' : received === expected;
  if (!routed) {
    process.stderr.write('unexpected git proxy route: expected ' + (fixture.direct ? 'direct' : expected) + ' but received ' + received + '\\n');
    process.exit(1);
  }
  for (const [path, contents] of Object.entries(fixture.files || {})) {
    const target = join(args[args.length - 1], path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  process.exit(0);
}
if (args[0] === '-C' && args[2] === 'rev-parse' && args[3] === 'HEAD') {
  process.stdout.write((process.env.AI_WORKFLOW_FIXTURE_HEAD || '') + '\\n');
  process.exit(0);
}
process.stderr.write('unexpected git invocation: ' + args.join(' ') + '\\n');
process.exit(2);
`;

// A real subprocess `scutil` shim. It logs every invocation, can fail like a missing/broken
// helper, and otherwise echoes the supplied `scutil --proxy` dictionary.
const SCUTIL_SHIM = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
if (process.env.AI_WORKFLOW_FIXTURE_SCUTIL_LOG) appendFileSync(process.env.AI_WORKFLOW_FIXTURE_SCUTIL_LOG, 'scutil called\\n');
if (process.env.AI_WORKFLOW_FIXTURE_SCUTIL_FAIL === '1') {
  process.stderr.write('scutil: proxy settings unavailable\\n');
  process.exit(1);
}
const source = process.env.AI_WORKFLOW_FIXTURE_SCUTIL;
process.stdout.write(source ? readFileSync(source, 'utf8') : '');
`;

type ScutilMode = 'https' | 'socks' | 'disabled' | 'invalid-port' | 'fail' | 'missing';

function scutilDictionary(entries: Array<[string, string | number]>): string {
  const lines = ['<dictionary> {'];
  for (const [key, value] of entries) lines.push(`  ${key} : ${value}`);
  lines.push('}', '');
  return lines.join('\n');
}

function scutilOutput(mode: 'https' | 'socks' | 'disabled' | 'invalid-port'): string {
  switch (mode) {
    case 'https':
      return scutilDictionary([['HTTPEnable', 1], ['HTTPPort', 7897], ['HTTPProxy', '127.0.0.1'], ['HTTPSEnable', 1], ['HTTPSPort', 7897], ['HTTPSProxy', '127.0.0.1'], ['SOCKSEnable', 0]]);
    case 'socks':
      return scutilDictionary([['HTTPSEnable', 0], ['SOCKSEnable', 1], ['SOCKSPort', 1080], ['SOCKSProxy', '::1']]);
    case 'disabled':
      return scutilDictionary([['HTTPEnable', 0], ['HTTPSEnable', 0], ['SOCKSEnable', 0]]);
    case 'invalid-port':
      return scutilDictionary([['HTTPSEnable', 1], ['HTTPSPort', 70000], ['HTTPSProxy', '127.0.0.1'], ['SOCKSEnable', 0]]);
  }
}

async function writeShim(directory: string, name: string, source: string): Promise<void> {
  const path = join(directory, name);
  await writeFile(path, source);
  await chmod(path, 0o755);
}

async function pathExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function readObserved(receivedPath: string): Promise<Record<string, string>> {
  return JSON.parse(await readFile(receivedPath, 'utf8')) as Record<string, string>;
}

describe('project template source acquisition honors the macOS system proxy', () => {
  let platformDescriptor: PropertyDescriptor;
  let savedEnv: Map<string, string | undefined>;
  const tempRoots: string[] = [];

  /**
   * Install the real subprocess shims and fixture env for one case: `git` always, `scutil` unless
   * `missing`, an HTTPS/SOCKS/disabled/invalid `scutil --proxy` dictionary, and the routing
   * expectation the git shim enforces. PATH is narrowed to the shim dir plus the node dir so a
   * real `/usr/sbin/scutil` can never leak into the `missing` case.
   */
  async function installFixture(config: {
    scutil: ScutilMode;
    expect?: { proxy?: string; direct?: boolean };
    env?: NodeJS.ProcessEnv;
  }): Promise<{ receivedPath: string; scutilLogPath: string }> {
    const binDirectory = await temporary('ai-workflow-network-shim-');
    const fixtureDirectory = await temporary('ai-workflow-network-fixture-');
    tempRoots.push(binDirectory, fixtureDirectory);
    await writeShim(binDirectory, 'git', GIT_NETWORK_SHIM);

    const receivedPath = join(fixtureDirectory, 'received.json');
    const scutilLogPath = join(fixtureDirectory, 'scutil.log');

    for (const key of MANAGED_ENV) delete process.env[key];
    Object.assign(process.env, config.env ?? {});
    process.env.PATH = `${binDirectory}${delimiter}${dirname(process.execPath)}${delimiter}/usr/bin`;
    process.env.AI_WORKFLOW_FIXTURE_HEAD = COMMIT;
    process.env.AI_WORKFLOW_FIXTURE_RECEIVED = receivedPath;
    process.env.AI_WORKFLOW_FIXTURE_SCUTIL_LOG = scutilLogPath;

    if (config.scutil !== 'missing') {
      await writeShim(binDirectory, 'scutil', SCUTIL_SHIM);
      if (config.scutil === 'fail') {
        process.env.AI_WORKFLOW_FIXTURE_SCUTIL_FAIL = '1';
      } else {
        const scutilPath = join(fixtureDirectory, 'scutil.txt');
        await writeFile(scutilPath, scutilOutput(config.scutil));
        process.env.AI_WORKFLOW_FIXTURE_SCUTIL = scutilPath;
      }
    }

    const fixture: Record<string, unknown> = { files: expectedFiles(COMMIT), ...(config.expect ?? {}) };
    const fixturePath = join(fixtureDirectory, 'fixture.json');
    await writeFile(fixturePath, JSON.stringify(fixture));
    process.env.AI_WORKFLOW_GIT_FIXTURE = fixturePath;

    return { receivedPath, scutilLogPath };
  }

  beforeEach(() => {
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true, enumerable: platformDescriptor.enumerable ?? true });
    savedEnv = new Map();
    for (const key of MANAGED_ENV) savedEnv.set(key, process.env[key]);
  });

  afterEach(async () => {
    Object.defineProperty(process, 'platform', platformDescriptor);
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('routes the enabled macOS system HTTPS proxy into the default git runner for the shallow clone', async () => {
    const { receivedPath, scutilLogPath } = await installFixture({ scutil: 'https', expect: { proxy: SYSTEM_PROXY_URL } });
    const expected = expectedFiles(COMMIT);

    const snapshot = await resolveTemplateSnapshot();

    expect(snapshot.source).toEqual({ repository: REPOSITORY, branch: BRANCH, commit: COMMIT });
    expect(Object.keys(snapshot.files).sort()).toEqual([...GENERATED_SOURCES].sort());
    for (const path of GENERATED_SOURCES) expect(snapshot.files[path]).toBe(expected[path]);
    const observed = await readObserved(receivedPath);
    expect(observed.https_proxy).toBe(SYSTEM_PROXY_URL);
    expect(observed.HTTPS_PROXY).toBe('');
    expect(observed.all_proxy).toBe('');
    expect(await pathExists(scutilLogPath)).toBe(true);
  });

  const explicitProxies: Array<{ name: string; value: string }> = [
    { name: 'https_proxy', value: 'http://127.0.0.1:8888' },
    { name: 'HTTPS_PROXY', value: 'http://127.0.0.1:8889' },
    { name: 'all_proxy', value: 'socks5h://127.0.0.1:8890' },
    { name: 'ALL_PROXY', value: 'socks5h://127.0.0.1:8891' },
  ];

  it.each(explicitProxies)('lets an explicit $name override different macOS system settings', async ({ name, value }) => {
    const { receivedPath, scutilLogPath } = await installFixture({ scutil: 'https', expect: { proxy: value }, env: { [name]: value } });

    const snapshot = await resolveTemplateSnapshot();

    expect(snapshot.source.commit).toBe(COMMIT);
    const observed = await readObserved(receivedPath);
    expect(observed[name]).toBe(value);
    for (const other of explicitProxies) if (other.name !== name) expect(observed[other.name]).toBe('');
    expect(Object.values(observed)).not.toContain(SYSTEM_PROXY_URL);
    expect(await pathExists(scutilLogPath), 'an explicit proxy must skip the OS lookup').toBe(false);
  });

  it('preserves caller no_proxy and NO_PROXY while merging the system HTTPS proxy', async () => {
    const { receivedPath } = await installFixture({ scutil: 'https', expect: { proxy: SYSTEM_PROXY_URL }, env: { no_proxy: 'example.com', NO_PROXY: 'internal.test' } });

    await resolveTemplateSnapshot();

    const observed = await readObserved(receivedPath);
    expect(observed.https_proxy).toBe(SYSTEM_PROXY_URL);
    expect(observed.no_proxy).toBe('example.com');
    expect(observed.NO_PROXY).toBe('internal.test');
  });

  const directModes: ScutilMode[] = ['disabled', 'missing', 'fail'];

  it.each(directModes)('falls back to ordinary direct acquisition when scutil is %s', async (mode) => {
    const { receivedPath } = await installFixture({ scutil: mode, expect: { direct: true } });

    const snapshot = await resolveTemplateSnapshot();

    expect(snapshot.source.commit).toBe(COMMIT);
    const observed = await readObserved(receivedPath);
    expect(observed.https_proxy).toBe('');
    expect(observed.HTTPS_PROXY).toBe('');
    expect(observed.all_proxy).toBe('');
    expect(observed.ALL_PROXY).toBe('');
  });

  it('ignores an invalid system proxy port and falls back to ordinary direct acquisition', async () => {
    const { receivedPath } = await installFixture({ scutil: 'invalid-port', expect: { direct: true } });

    const snapshot = await resolveTemplateSnapshot();

    expect(snapshot.source.commit).toBe(COMMIT);
    const observed = await readObserved(receivedPath);
    expect(observed.https_proxy).toBe('');
    expect(observed.all_proxy).toBe('');
  });

  it('routes an enabled SOCKS system proxy as socks5h with a bracketed IPv6 authority', async () => {
    const { receivedPath } = await installFixture({ scutil: 'socks', expect: { proxy: 'socks5h://[::1]:1080' } });

    const snapshot = await resolveTemplateSnapshot();

    expect(snapshot.source.commit).toBe(COMMIT);
    const observed = await readObserved(receivedPath);
    expect(observed.all_proxy).toBe('socks5h://[::1]:1080');
    expect(observed.https_proxy).toBe('');
  });

  it('ignores the macOS system proxy on non-darwin platforms', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true, enumerable: platformDescriptor.enumerable ?? true });
    const { receivedPath, scutilLogPath } = await installFixture({ scutil: 'https', expect: { direct: true } });

    const snapshot = await resolveTemplateSnapshot();

    expect(snapshot.source.commit).toBe(COMMIT);
    const observed = await readObserved(receivedPath);
    expect(observed.https_proxy).toBe('');
    expect(observed.all_proxy).toBe('');
    expect(await pathExists(scutilLogPath), 'non-darwin must not consult scutil').toBe(false);
  });
});
