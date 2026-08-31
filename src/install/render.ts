import { readFile, readdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { packagePath } from '../utils/schema.js';
import type { Host } from '../workflow/types.js';

export interface RenderedFile { relativePath: string; contents: string }

function frontmatterFor(host: Host, source: string): string {
  if (host === 'codex') return source;
  if (host === 'claude') return source.replace(/^tools: \[(.*)]$/m, 'allowed-tools: [$1]');
  return source.replace(/^tools: \[(.*)]$/m, (_match, tools: string) => {
    const permissions = tools.split(',').map((tool) => tool.trim()).filter(Boolean).flatMap((tool) => {
      const key = tool === 'shell' ? 'bash' : tool;
      // OpenCode models search as a combination of filename and content queries.
      if (key === 'search') return [['glob', 'allow'], ['grep', 'allow'], ['list', 'allow']];
      return [[key, 'allow']];
    });
    return `permission:\n${permissions.map(([key, action]) => `  ${key}: ${action}`).join('\n')}`;
  });
}

function agentFrontmatterFor(host: Host, source: string): string {
  const rendered = frontmatterFor(host, source);
  return host === 'opencode' ? rendered.replace(/^---\n/, '---\nhidden: true\n') : rendered;
}

async function markdownFiles(root: string): Promise<string[]> {
  const names = await readdir(root, { withFileTypes: true }); const result: string[] = [];
  for (const name of names) { const path = join(root, name.name); if (name.isDirectory()) result.push(...await markdownFiles(path)); else if (name.name.endsWith('.md')) result.push(path); }
  return result;
}

export async function renderHost(host: Host, version: string): Promise<{ plugin: RenderedFile[]; agents: RenderedFile[] }> {
  const skillRoot = packagePath('templates', 'skills'); const agentRoot = packagePath('templates', 'agents');
  const plugin: RenderedFile[] = []; const agents: RenderedFile[] = [];
  for (const path of await markdownFiles(skillRoot)) plugin.push({ relativePath: `skills/${relative(skillRoot, path)}`, contents: frontmatterFor(host, await readFile(path, 'utf8')) });
  for (const path of await markdownFiles(agentRoot)) agents.push({ relativePath: basename(path), contents: agentFrontmatterFor(host, await readFile(path, 'utf8')) });
  if (host !== 'opencode') {
    const manifestPath = packagePath('templates', 'hosts', host, `.${host === 'codex' ? 'codex' : 'claude'}-plugin`, 'plugin.json');
    plugin.push({ relativePath: `.${host === 'codex' ? 'codex' : 'claude'}-plugin/plugin.json`, contents: (await readFile(manifestPath, 'utf8')).replaceAll('{{version}}', version) });
  }
  return { plugin, agents };
}
