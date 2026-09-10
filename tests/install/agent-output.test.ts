import { describe, expect, it } from 'vitest';
import { renderHost } from '../../src/install/render.js';
import type { Host } from '../../src/workflow/types.js';

const roleHeadings = {
  backend: '# Backend Developer',
  'documentation-maintainer': '# Documentation Maintainer',
  'file-explorer': '# File Explorer',
  frontend: '# Frontend Developer',
  'git-operator': '# Git Operator',
  researcher: '# Researcher',
  'spec-review': '# Spec Review',
  'standards-review': '# Standards Review',
  'task-worker': '# Task Worker',
  test: '# Test'
} as const;

type Role = keyof typeof roleHeadings;

function codexInstructions(contents: string): string {
  const line = contents.match(/^developer_instructions = ("(?:\\.|[^"\\])*")$/m)?.[1];
  if (!line) throw new Error('Codex output did not contain developer_instructions');
  return JSON.parse(line) as string;
}

function instructions(host: Host, contents: string): string {
  return host === 'codex' ? codexInstructions(contents) : contents;
}

describe('installed agent output contracts', () => {
  it('renders all ten roles as Markdown contracts for every supported host', async () => {
    const hosts: Host[] = ['codex', 'claude', 'opencode'];

    for (const host of hosts) {
      const files = await renderHost(host);
      expect(files).toHaveLength(Object.keys(roleHeadings).length);

      for (const [role, heading] of Object.entries(roleHeadings) as [Role, string][]) {
        const file = files.find((candidate) => candidate.relativePath === `${role}${host === 'codex' ? '.toml' : '.md'}`);
        expect(file, `${host}/${role} output`).toBeDefined();
        const body = instructions(host, file!.contents);

        expect(body).toContain(heading);
        expect(body).toMatch(/^## Status$/m);
        expect(body).toMatch(/^## Summary$/m);
        expect(body).toMatch(/^## Evidence$/m);
        expect(body).toMatch(/^## Support Requests$/m);
        expect(body).toMatch(/Markdown/i);
        expect(body).toMatch(/(?:Do not|Never|must not|禁止).{0,80}JSON envelope/i);
        expect(body).not.toContain('schemas/result.schema.json');
        expect(body).not.toMatch(/result envelope/i);
        expect(body).not.toContain('changed_paths');
      }
    }
  });

  it('uses Found Paths for File Explorer discovery output', async () => {
    for (const host of ['codex', 'claude', 'opencode'] as Host[]) {
      const file = (await renderHost(host)).find((candidate) => candidate.relativePath.startsWith('file-explorer.'));
      expect(file).toBeDefined();
      const body = instructions(host, file!.contents);
      expect(body).toMatch(/Found Paths/i);
      expect(body).not.toContain('changed_paths');
    }
  });
});
