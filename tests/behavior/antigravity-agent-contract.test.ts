import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { install, uninstall } from '../../src/install/index.js';
import { renderHost } from '../../src/install/render.js';
import type { Profile } from '../../src/profile/index.js';
import { packagePath } from '../../src/utils/schema.js';
import { temporary } from '../helpers.js';

// Antigravity consumes native Markdown role agents: frontmatter declares dispatch flags and
// mapped tool names, while the template Markdown body is installed byte-for-byte.
const expectedTools: Record<string, string[]> = {
  backend: ['read_file', 'edit_file', 'write_file', 'run_command', 'manage_task'],
  'documentation-maintainer': ['read_file', 'edit_file', 'write_file'],
  'file-explorer': ['read_file', 'run_command', 'manage_task'],
  frontend: ['read_file', 'edit_file', 'write_file', 'run_command', 'manage_task'],
  'git-operator': ['read_file', 'run_command', 'manage_task'],
  researcher: ['read_file', 'search_web'],
  'spec-review': ['read_file'],
  'standards-review': ['read_file'],
  test: ['read_file', 'edit_file', 'write_file', 'run_command', 'manage_task']
};
const roles = Object.keys(expectedTools);

function splitFrontmatter(contents: string): { head: string; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(contents);
  if (!match) throw new Error('Rendered agent has no frontmatter');
  return { head: match[1] as string, body: match[2] as string };
}

function toolsOf(head: string): string[] {
  const line = /^tools: \[(.*)\]$/m.exec(head)?.[1];
  if (line === undefined) throw new Error('Rendered agent has no tools list');
  return line.split(',').map((tool) => tool.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

async function readManifest(home: string): Promise<{ hosts: Record<string, unknown> }> {
  return JSON.parse(await readFile(join(home, '.config/ai-workflow/install-manifest.json'), 'utf8')) as { hosts: Record<string, unknown> };
}

describe('Antigravity role agent rendering', () => {
  it('renders nine native Markdown agents with dispatch flags, exact tools and untouched template bodies', async () => {
    const files = await renderHost('antigravity');
    expect(files).toHaveLength(roles.length);
    const templateRoot = packagePath('templates', 'agents');

    for (const role of roles) {
      const file = files.find((candidate) => candidate.relativePath === `${role}.md`);
      expect(file, `${role} output`).toBeDefined();
      if (!file) throw new Error(`Missing rendered agent for ${role}`);
      const { head, body } = splitFrontmatter(file.contents);

      expect(head, `${role} name`).toMatch(new RegExp(`^name:\\s*['"]?${role}['"]?\\s*$`, 'm'));
      expect(head, `${role} description`).toMatch(/^description: \S/m);
      const declaredTools = expectedTools[role]!;
      expect(toolsOf(head), `${role} tools`).toEqual(declaredTools);
      expect(head, `${role} subagent flag`).toMatch(/^subagent: true$/m);
      expect(head, `${role} mainAgent flag`).toMatch(/^mainAgent: false$/m);
      expect(head, `${role} model omission`).not.toMatch(/^model:/m);
      // Shell-capable roles auto-run routine project commands; read-only roles carry no policy.
      const shellCapable = declaredTools.some((tool) => tool === 'run_command' || tool === 'manage_task');
      if (shellCapable) expect(head, `${role} command execution policy`).toMatch(/^commandExecutionPolicy: auto$/m);
      else expect(head, `${role} command execution policy`).not.toMatch(/^commandExecutionPolicy:/m);

      const template = await readFile(join(templateRoot, `${role}.md`), 'utf8');
      expect(body, `${role} body`).toBe(splitFrontmatter(template).body);
    }
  });

  it('maps the template tool vocabulary in declaration order without duplicate native tools', async () => {
    const files = await renderHost('antigravity');
    const headOf = (role: string): string => {
      const file = files.find((candidate) => candidate.relativePath === `${role}.md`);
      if (!file) throw new Error(`Missing rendered agent for ${role}`);
      return splitFrontmatter(file.contents).head;
    };

    // `edit` expands into two tools before `shell`, and `read` stays first.
    expect(toolsOf(headOf('backend'))).toEqual(['read_file', 'edit_file', 'write_file', 'run_command', 'manage_task']);
    // `search` yields the same pair as `shell` and adds no duplicate native tool.
    expect(toolsOf(headOf('file-explorer'))).toEqual(['read_file', 'run_command', 'manage_task']);
    expect(toolsOf(headOf('researcher'))).toEqual(['read_file', 'search_web']);
  });

  it('never offers nested subagent dispatch to an Antigravity role', async () => {
    for (const file of await renderHost('antigravity')) {
      for (const forbidden of ['invoke_subagent', 'define_subagent', 'manage_subagents']) {
        expect(file.contents, `${file.relativePath} contains ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('omits the model key from rendered agents when the tier is inherit', async () => {
    const profile: Profile = {
      version: '1.0.0',
      agents: { backend: { antigravity: { model: 'inherit' } } }
    };
    const files = await renderHost('antigravity', profile);
    const backend = files.find((candidate) => candidate.relativePath === 'backend.md');
    if (!backend) throw new Error('Missing rendered antigravity backend');
    const { head } = splitFrontmatter(backend.contents);
    expect(head, 'inherit tier must omit the model key').not.toMatch(/^model:/m);
  });

  it('renders explicit Antigravity model tiers in the frontmatter', async () => {
    for (const tier of ['pro', 'flash_lite'] as const) {
      const profile: Profile = {
        version: '1.0.0',
        agents: { backend: { antigravity: { model: tier } } }
      };
      const files = await renderHost('antigravity', profile);
      const backend = files.find((candidate) => candidate.relativePath === 'backend.md');
      if (!backend) throw new Error('Missing rendered antigravity backend');
      const { head } = splitFrontmatter(backend.contents);
      expect(head, `${tier} tier`).toMatch(new RegExp(`^model: "${tier}"$`, 'm'));
    }
  });
});

describe('Antigravity host acceptance at the install boundary', () => {
  it('accepts antigravity on install and records the host with agents under .gemini', async () => {
    const home = await temporary('ai-workflow-antigravity-install-');
    await expect(install(['antigravity'], { home })).resolves.toBeDefined();

    const manifest = await readManifest(home);
    expect(manifest.hosts.antigravity).toBeDefined();
    expect((manifest.hosts.antigravity as unknown[]).length).toBeGreaterThan(0);
    await expect(readdir(join(home, '.gemini/config/agents'))).resolves.toContain('backend.md');
  });

  it('accepts antigravity on uninstall and clears its host record', async () => {
    const home = await temporary('ai-workflow-antigravity-uninstall-');
    await install(['antigravity'], { home });
    await expect(uninstall(['antigravity'], { home })).resolves.toBeDefined();

    const manifest = await readManifest(home);
    expect(manifest.hosts.antigravity).toBeUndefined();
  });

  it('includes antigravity when installing the full supported host set', async () => {
    const home = await temporary('ai-workflow-antigravity-all-');
    await expect(install(['codex', 'claude', 'opencode', 'antigravity'], { home })).resolves.toBeDefined();

    const manifest = await readManifest(home);
    expect(Object.keys(manifest.hosts).sort()).toEqual(['antigravity', 'claude', 'codex', 'opencode']);
  });
});
