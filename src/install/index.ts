import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { atomicDirectory, atomicWrite, exists, readJson, writeJson } from '../utils/fs.js';
import { sha256 } from '../utils/hash.js';
import { renderHost, type RenderedFile } from './render.js';
import type { Host } from '../workflow/types.js';

interface ManifestFile { path: string; digest: string; kind: 'file' | 'directory' }
interface InstallManifest { version: string; installed_at: string; hosts: Partial<Record<Host, ManifestFile[]>> }
const manifestRelative = '.config/ai-workflow/install-manifest.json';

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

export async function install(hosts: Host[], options: { home?: string; version?: string } = {}): Promise<InstallManifest> {
  const home = resolve(options.home ?? homedir()); const version = options.version ?? '0.1.0'; const manifest = await readManifest(home);
  for (const host of hosts) {
    const rendered = await renderHost(host, version); const target = roots(home, host); const owned: ManifestFile[] = [];
    if (target.plugin) { await atomicDirectory(target.plugin, (temporary) => writeRendered(temporary, rendered.plugin)); owned.push({ path: relative(home, target.plugin), digest: sha256(JSON.stringify(rendered.plugin)), kind: 'directory' }); }
    if (target.skills) for (const file of rendered.plugin.filter((item) => item.relativePath.endsWith('SKILL.md'))) { const parts = file.relativePath.split('/'); const skill = parts.at(-2) ?? ''; const path = join(target.skills, `ai-workflow-${skill}`); await atomicDirectory(path, (temporary) => writeRendered(temporary, [{ ...file, relativePath: 'SKILL.md' }])); owned.push({ path: relative(home, path), digest: sha256(file.contents), kind: 'directory' }); }
    for (const file of rendered.agents) { const path = join(target.agents, `ai-workflow-${file.relativePath}`); await atomicWrite(path, file.contents); owned.push({ path: relative(home, path), digest: sha256(file.contents), kind: 'file' }); }
    if (host === 'codex') owned.push(await mergeMarketplace(home, version));
    manifest.hosts[host] = owned;
  }
  manifest.version = version; manifest.installed_at = new Date().toISOString(); await writeJson(join(home, manifestRelative), manifest); return manifest;
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
  const conflicts = [] as string[]; for (const item of targets) if (await exists(join(root, item.target))) conflicts.push(item.target);
  if (conflicts.length) throw new Error(`Initialization conflicts; no files written. Merge these templates manually: ${conflicts.join(', ')}`);
  for (const item of targets) { const contents = await readFile(new URL(`../../${item.source}`, import.meta.url), 'utf8'); await atomicWrite(join(root, item.target), contents); created.push(item.target); }
  const ignorePath = join(root, '.gitignore'); const ignore = await exists(ignorePath) ? await readFile(ignorePath, 'utf8') : ''; const additions = ['.ai-workflow/runs/', '*.log'].filter((line) => !ignore.split(/\r?\n/).includes(line)); if (additions.length) { await atomicWrite(ignorePath, `${ignore.trimEnd()}${ignore ? '\n' : ''}${additions.join('\n')}\n`); created.push('.gitignore'); }
  return created;
}
