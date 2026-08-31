import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { atomicDirectory, atomicWrite, exists, readJson, writeJson } from '../utils/fs.js';
import { sha256 } from '../utils/hash.js';
import { renderHost, type RenderedFile } from './render.js';
import { loadProfile, type Profile } from '../profile/index.js';
import type { Host } from '../workflow/types.js';

interface ManifestFile { path: string; digest: string; kind: 'file' | 'directory' }
interface InstallManifest { version: string; installed_at: string; hosts: Partial<Record<Host, ManifestFile[]>> }
export interface AgentInstallation {
  name: string;
  path: string;
  model?: string;
  reasoning_effort?: string;
}
export interface HostInstallation {
  host: Host;
  agents_directory: string;
  agents: AgentInstallation[];
}
export interface ProfileActivationReport {
  active_profile: string;
  hosts: Host[];
  installations: HostInstallation[];
}
const manifestRelative = '.config/ai-workflow/install-manifest.json';
const activeProfileRelative = '.config/ai-workflow/active-profile';

function roots(home: string, host: Host): { plugin?: string; skills?: string; agents: string } {
  if (host === 'codex') return { plugin: join(home, '.codex/plugins/ai-workflow'), agents: join(home, '.codex/agents') };
  if (host === 'claude') return { plugin: join(home, '.claude/skills/ai-workflow'), agents: join(home, '.claude/skills/ai-workflow/agents') };
  return { skills: join(home, '.config/opencode/skills'), agents: join(home, '.config/opencode/agents') };
}

async function writeRendered(root: string, files: RenderedFile[]): Promise<void> { for (const file of files) { const target = join(root, file.relativePath); await mkdir(dirname(target), { recursive: true }); await writeFile(target, file.contents); } }

async function readManifest(home: string): Promise<InstallManifest> {
  const path = join(home, manifestRelative); return await exists(path) ? readJson<InstallManifest>(path) : { version: '1', installed_at: new Date(0).toISOString(), hosts: {} };
}

async function mergeMarketplace(home: string, version: string): Promise<ManifestFile> {
  const path = join(home, '.agents/plugins/marketplace.json'); let content: Record<string, unknown> = {};
  if (await exists(path)) { const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown; if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('marketplace.json must be an object'); content = parsed as Record<string, unknown>; }
  const existing: unknown[] = Array.isArray(content.plugins) ? content.plugins as unknown[] : [];
  const retained = existing.filter((entry) => !(entry && typeof entry === 'object' && (entry as Record<string, unknown>).name === 'ai-workflow'));
  content.name = typeof content.name === 'string' ? content.name : 'ai-workflow-local';
  content.plugins = [...retained, { name: 'ai-workflow', source: { source: 'local', path: './.codex/plugins/ai-workflow' }, policy: { installation: 'INSTALLED_BY_DEFAULT', authentication: 'ON_INSTALL' }, category: 'Productivity', version }]; await writeJson(path, content); return { path: relative(home, path), digest: sha256(await readFile(path)), kind: 'file' };
}

async function removeStaleOwnedFiles(home: string, previous: ManifestFile[], current: ManifestFile[]): Promise<void> {
  const retained = new Set(current.map((file) => file.path));
  for (const file of previous) {
    if (retained.has(file.path) || file.path === '.agents/plugins/marketplace.json') continue;
    const path = resolve(home, file.path);
    if (!path.startsWith(`${home}/`)) throw new Error(`Unsafe manifest path: ${file.path}`);
    await rm(path, { recursive: file.kind === 'directory', force: true });
  }
}

export async function install(hosts: Host[], options: { home?: string; version?: string; profile?: Profile } = {}): Promise<InstallManifest> {
  const home = resolve(options.home ?? homedir()); const version = options.version ?? '0.1.0'; const manifest = await readManifest(home);
  const activeName = options.profile ? undefined : await getActiveProfile(home); const profile = options.profile ?? (activeName ? await loadProfile(home, activeName) : undefined);
  if (hosts.includes('codex')) {
    const marketplace = join(home, '.agents/plugins/marketplace.json');
    if (await exists(marketplace)) { const parsed = JSON.parse(await readFile(marketplace, 'utf8')) as unknown; if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('marketplace.json must be an object'); }
  }
  const renderedHosts = new Map<Host, Awaited<ReturnType<typeof renderHost>>>(); for (const host of hosts) renderedHosts.set(host, await renderHost(host, version, profile));
  for (const host of hosts) {
    const rendered = renderedHosts.get(host); if (!rendered) throw new Error(`Missing rendered host: ${host}`); const target = roots(home, host); const owned: ManifestFile[] = [];
    if (target.plugin) { await atomicDirectory(target.plugin, (temporary) => writeRendered(temporary, rendered.plugin)); owned.push({ path: relative(home, target.plugin), digest: sha256(JSON.stringify(rendered.plugin)), kind: 'directory' }); }
    if (target.skills) for (const file of rendered.plugin.filter((item) => item.relativePath.endsWith('SKILL.md'))) { const parts = file.relativePath.split('/'); const skill = parts.at(-2) ?? ''; const path = join(target.skills, skill); await atomicDirectory(path, (temporary) => writeRendered(temporary, [{ ...file, relativePath: 'SKILL.md' }])); owned.push({ path: relative(home, path), digest: sha256(file.contents), kind: 'directory' }); }
    for (const file of rendered.agents) { const path = join(target.agents, file.relativePath); await atomicWrite(path, file.contents); owned.push({ path: relative(home, path), digest: sha256(file.contents), kind: 'file' }); }
    if (host === 'codex') owned.push(await mergeMarketplace(home, version));
    await removeStaleOwnedFiles(home, manifest.hosts[host] ?? [], owned);
    manifest.hosts[host] = owned;
  }
  manifest.version = version; manifest.installed_at = new Date().toISOString(); await writeJson(join(home, manifestRelative), manifest); return manifest;
}

export async function getActiveProfile(home: string): Promise<string | undefined> {
  const path = join(resolve(home), activeProfileRelative); if (!(await exists(path))) return undefined;
  const name = (await readFile(path, 'utf8')).trim(); return name || undefined;
}

function profileInstallations(home: string, hosts: Host[], manifest: InstallManifest, profile: Profile): HostInstallation[] {
  return hosts.map((host) => {
    const agentsDirectory = roots(home, host).agents;
    const agents = (manifest.hosts[host] ?? []).flatMap((file): AgentInstallation[] => {
      const path = resolve(home, file.path);
      if (file.kind !== 'file' || dirname(path) !== agentsDirectory) return [];
      const agentName = basename(path, extname(path));
      const settings = profile.agents[agentName]?.[host];
      return [{
        name: agentName,
        path,
        ...(settings ? { model: settings.model, reasoning_effort: settings.reasoning_effort } : {})
      }];
    });
    return { host, agents_directory: agentsDirectory, agents };
  });
}

export async function activateProfile(name: string, options: { home?: string; version?: string } = {}): Promise<ProfileActivationReport> {
  const home = resolve(options.home ?? homedir()); const profile = await loadProfile(home, name); const manifest = await readManifest(home);
  const hosts = (Object.keys(manifest.hosts) as Host[]).filter((host) => ['codex', 'claude', 'opencode'].includes(host));
  const installed = hosts.length ? await install(hosts, { home, version: options.version ?? manifest.version, profile }) : manifest;
  await atomicWrite(join(home, activeProfileRelative), `${name}\n`);
  return { active_profile: name, hosts, installations: profileInstallations(home, hosts, installed, profile) };
}

export async function uninstall(hosts: Host[], options: { home?: string } = {}): Promise<InstallManifest> {
  const home = resolve(options.home ?? homedir()); const manifest = await readManifest(home);
  for (const host of hosts) {
    for (const file of manifest.hosts[host] ?? []) {
      const path = resolve(home, file.path); if (!path.startsWith(`${home}/`)) throw new Error(`Unsafe manifest path: ${file.path}`);
      if (host === 'codex' && file.path === '.agents/plugins/marketplace.json' && await exists(path)) {
        const data = await readJson<Record<string, unknown>>(path); if (Array.isArray(data.plugins)) { data.plugins = data.plugins.filter((entry) => !(entry && typeof entry === 'object' && (entry as Record<string, unknown>).name === 'ai-workflow')); await writeJson(path, data); }
      } else await rm(path, { recursive: file.kind === 'directory', force: true });
    }
    manifest.hosts = Object.fromEntries(Object.entries(manifest.hosts).filter(([key]) => key !== host)) as InstallManifest['hosts'];
  }
  await writeJson(join(home, manifestRelative), manifest); return manifest;
}

export async function initializeProject(project: string): Promise<string[]> {
  const root = resolve(project); const created: string[] = [];
  const templates = ['AGENTS.md', 'MEMORY.md', 'navigation.md', 'config.yaml'];
  const targets = templates.map((name) => ({ source: join('templates/project', name), target: name === 'navigation.md' ? '.ai-workflow/index/navigation.md' : name === 'config.yaml' ? '.ai-workflow/config.yaml' : name }));
  const conflicts: Array<{ target: string; contents: string }> = []; for (const item of targets) if (await exists(join(root, item.target))) conflicts.push({ target: item.target, contents: await readFile(new URL(`../../${item.source}`, import.meta.url), 'utf8') });
  if (conflicts.length) throw new Error(`Initialization conflicts; no files written. Merge these templates manually:\n${conflicts.map((item) => `${item.target}\n--- proposed ---\n${item.contents}`).join('\n')}`);
  for (const item of targets) { const contents = await readFile(new URL(`../../${item.source}`, import.meta.url), 'utf8'); await atomicWrite(join(root, item.target), contents); created.push(item.target); }
  const ignorePath = join(root, '.gitignore'); const ignore = await exists(ignorePath) ? await readFile(ignorePath, 'utf8') : ''; const additions = ['.ai-workflow/runs/', '*.log'].filter((line) => !ignore.split(/\r?\n/).includes(line)); if (additions.length) { await atomicWrite(ignorePath, `${ignore.trimEnd()}${ignore ? '\n' : ''}${additions.join('\n')}\n`); created.push('.gitignore'); }
  return created;
}
