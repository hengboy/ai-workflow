import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderHost } from '../../src/install/render.js';
import { packagePath } from '../../src/utils/schema.js';

// OpenCode V2 replaces the V1 `tools`/`permission`/`hidden` agent frontmatter. Role agents must be
// `mode: subagent` so the primary orchestrator can dispatch them through the `subagent` tool;
// `hidden: true` removes an agent from the subagent catalog and breaks every dispatch.
const expectedActions: Record<string, string[]> = {
  backend: ['read', 'edit', 'shell'],
  'documentation-maintainer': ['read', 'edit'],
  'file-explorer': ['read', 'glob', 'grep'],
  frontend: ['read', 'edit', 'shell'],
  'git-operator': ['read', 'shell'],
  researcher: ['read', 'webfetch', 'websearch'],
  'spec-review': ['read'],
  'standards-review': ['read'],
  test: ['read', 'shell']
};

function frontmatter(contents: string): string {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(contents);
  if (!match) throw new Error('Rendered agent has no frontmatter');
  return match[1] as string;
}

function permissionActions(rendered: string): string[] {
  return [...rendered.matchAll(/^  - action: (\S+)$/gm)].map((match) => match[1] as string);
}

const rule = (action: string, effect: string): string => `  - action: ${action}\n    resource: "*"\n    effect: ${effect}`;

describe('opencode v2 role agent frontmatter', () => {
  it('renders every role as a dispatchable subagent with ordered permission rules', async () => {
    const files = await renderHost('opencode');
    expect(files).toHaveLength(Object.keys(expectedActions).length);

    for (const [role, actions] of Object.entries(expectedActions)) {
      const file = files.find((candidate) => candidate.relativePath === `${role}.md`);
      expect(file, `${role} output`).toBeDefined();
      if (!file) throw new Error(`Missing rendered agent for ${role}`);
      const head = frontmatter(file.contents);

      expect(head).toContain('mode: subagent');
      expect(head).not.toContain('hidden: true');
      expect(head).not.toMatch(/^permission:/m);
      expect(head).not.toMatch(/^tools:/m);
      for (const action of actions) expect(head).toContain(rule(action, 'allow'));
    }
  });

  it('translates the template tool vocabulary into native v2 actions', async () => {
    const files = await renderHost('opencode');
    const actionsOf = (role: string): string[] => {
      const file = files.find((candidate) => candidate.relativePath === `${role}.md`);
      if (!file) throw new Error(`Missing rendered agent for ${role}`);
      return permissionActions(file.contents);
    };

    // `search` maps to the separate discovery tools; `list` is no longer a v2 action.
    expect(actionsOf('file-explorer')).toEqual(['read', 'glob', 'grep', 'subagent']);
    // `web` maps to both web tools.
    expect(actionsOf('researcher')).toEqual(['read', 'webfetch', 'websearch', 'subagent']);
    expect(actionsOf('spec-review')).toEqual(['read', 'subagent']);
  });

  it('never grants a role agent nested subagent dispatch', async () => {
    for (const file of await renderHost('opencode')) {
      const head = frontmatter(file.contents);
      expect(head, file.relativePath).toContain(rule('subagent', 'deny'));
      expect(head, file.relativePath).not.toContain(rule('subagent', 'allow'));
    }
  });

  it('keeps the template tool declaration as the single source for every host', async () => {
    const root = packagePath('templates', 'agents');
    for (const role of Object.keys(expectedActions)) {
      const template = await readFile(join(root, `${role}.md`), 'utf8');
      expect(template, role).toMatch(/^tools: \[[a-z, ]+\]$/m);
    }
  });
});
