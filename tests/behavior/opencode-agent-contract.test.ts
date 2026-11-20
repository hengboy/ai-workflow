import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderHost } from '../../src/install/render.js';
import { packagePath } from '../../src/utils/schema.js';
import type { Profile } from '../../src/profile/index.js';

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

describe('opencode v1 role agent frontmatter', () => {
  it('renders every role with singular permission keys (bash/task)', async () => {
    const files = await renderHost('opencode', undefined, { opencodeVersion: 'v1' });
    expect(files).toHaveLength(Object.keys(expectedActions).length);

    for (const file of files) {
      const head = frontmatter(file.contents);
      expect(head, file.relativePath).toContain('mode: subagent');
      expect(head, file.relativePath).toMatch(/^permission:$/m);
      expect(head, file.relativePath).not.toMatch(/^permissions:$/m);
      expect(head, file.relativePath).not.toMatch(/^tools:/m);
      expect(head, file.relativePath).toContain('  task: deny');
      expect(head, file.relativePath).not.toContain('action:');
      expect(head, file.relativePath).not.toMatch(/^  shell:/m);
    }

    const headOf = (role: string): string => {
      const file = files.find((candidate) => candidate.relativePath === `${role}.md`);
      if (!file) throw new Error(`Missing rendered agent for ${role}`);
      return frontmatter(file.contents);
    };
    expect(headOf('backend')).toContain('  bash: allow');
    expect(headOf('backend')).toContain('  edit: allow');
    expect(headOf('file-explorer')).toContain('  glob: allow');
    expect(headOf('file-explorer')).toContain('  grep: allow');
    expect(headOf('researcher')).toContain('  webfetch: allow');
    expect(headOf('researcher')).toContain('  websearch: allow');
  });
});

describe('opencode model variant rendering', () => {
  it('renders every role model and reasoning effort as a native variant for v1 and v2', async () => {
    const roles = Object.keys(expectedActions);
    const agents: Profile['agents'] = {};
    for (const role of roles) {
      agents[role] = { opencode: { model: `gateway/${role}-model`, reasoning_effort: 'high' } };
    }
    const profile: Profile = { version: '1.0.0', agents };

    for (const opencodeVersion of ['v1', 'v2'] as const) {
      const files = await renderHost('opencode', profile, { opencodeVersion });
      expect(files, opencodeVersion).toHaveLength(roles.length);
      for (const role of roles) {
        const file = files.find((candidate) => candidate.relativePath === `${role}.md`);
        expect(file, `${opencodeVersion}/${role} output`).toBeDefined();
        if (!file) throw new Error(`Missing rendered agent for ${role}`);
        const head = frontmatter(file.contents);
        expect(head, `${opencodeVersion}/${role}`).toContain(`model: "gateway/${role}-model"`);
        expect(head, `${opencodeVersion}/${role}`).toContain('variant: "high"');
        expect(head, `${opencodeVersion}/${role}`).not.toContain('reasoningEffort');
      }
    }
  });
});

describe('host agent name frontmatter', () => {
  // OpenCode derives the agent ID from the file name and ignores a V1 `name` field, logging
  // `ignored unsupported agent fields ... fields=["name"]`. The installer must omit `name`
  // from OpenCode frontmatter while keeping `description` and each native host's name field.
  it('omits name from OpenCode v1 and v2 frontmatter while keeping description and native host names', async () => {
    const profile: Profile = {
      version: '1.0.0',
      agents: {
        backend: {
          codex: { model: 'gpt-5.6', reasoning_effort: 'high' },
          claude: { model: 'opus', reasoning_effort: 'max' }
        }
      }
    };

    for (const opencodeVersion of ['v1', 'v2'] as const) {
      const files = await renderHost('opencode', profile, { opencodeVersion });
      expect(files, opencodeVersion).toHaveLength(Object.keys(expectedActions).length);
      for (const file of files) {
        const head = frontmatter(file.contents);
        expect(head, `${opencodeVersion}/${file.relativePath}`).not.toMatch(/^name:/m);
        expect(head, `${opencodeVersion}/${file.relativePath}`).toMatch(/^description:/m);
      }
    }

    const codex = await renderHost('codex', profile);
    const codexBackend = codex.find((candidate) => candidate.relativePath === 'backend.toml');
    expect(codexBackend, 'codex backend output').toBeDefined();
    if (!codexBackend) throw new Error('Missing rendered codex backend');
    expect(codexBackend.contents).toContain('name = "backend"');

    const claude = await renderHost('claude', profile);
    const claudeBackend = claude.find((candidate) => candidate.relativePath === 'backend.md');
    expect(claudeBackend, 'claude backend output').toBeDefined();
    if (!claudeBackend) throw new Error('Missing rendered claude backend');
    expect(claudeBackend.contents).toMatch(/^name: backend$/m);
  });
});

describe('role template packet handling (REQ-004)', () => {
  it('requires exact absolute paths and an explicit per-command workdir for every role', async () => {
    const root = packagePath('templates', 'agents');
    for (const role of Object.keys(expectedActions)) {
      const template = await readFile(join(root, `${role}.md`), 'utf8');
      expect(template, `${role} states exact absolute paths`).toMatch(/absolute path/i);
      expect(template, `${role} states a per-command workdir`).toMatch(/workdir|working directory/i);
    }
  });

  it('records the per-repository worktree requirement for the Git Operator', async () => {
    const template = await readFile(join(packagePath('templates', 'agents'), 'git-operator.md'), 'utf8');
    expect(template).toContain('<source-root>/.worktrees/<planId>');
    expect(template).toContain('ai-workflow/<planId>');
  });
});
