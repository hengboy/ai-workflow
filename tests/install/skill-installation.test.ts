import { describe, expect, it } from 'vitest';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { install } from '../../src/install/index.js';
import { renderHost } from '../../src/install/render.js';
import { exists } from '../../src/utils/fs.js';
import { packagePath } from '../../src/utils/schema.js';
import { temporary } from '../helpers.js';
import type { Host } from '../../src/workflow/types.js';

const hosts: Host[] = ['codex', 'claude', 'opencode'];
const configRelative = '.config/ai-workflow/config.yaml';
const manifestRelative = '.config/ai-workflow/install-manifest.json';
const skillsRelative = '.agents/skills';
const directiveHeading = '## Output language';

function agentsRelative(host: Host): string {
  if (host === 'codex') return '.codex/agents';
  if (host === 'claude') return '.claude/agents';
  return '.config/opencode/agents';
}

async function seedConfig(home: string, contents: string): Promise<void> {
  await mkdir(join(home, '.config/ai-workflow'), { recursive: true });
  await writeFile(join(home, configRelative), contents);
}

async function filesUnder(root: string): Promise<string[]> {
  if (!(await exists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else files.push(path);
  }
  return files;
}

// Snapshot of every managed file plus the install manifest, excluding the user-owned configuration.
async function managedTree(home: string): Promise<Map<string, string>> {
  const paths = await filesUnder(join(home, skillsRelative));
  for (const host of hosts) paths.push(...await filesUnder(join(home, agentsRelative(host))));
  const manifest = join(home, manifestRelative);
  if (await exists(manifest)) paths.push(manifest);
  const tree = new Map<string, string>();
  for (const path of paths) tree.set(relative(home, path), await readFile(path, 'utf8'));
  return tree;
}

describe('installed skills and agents', () => {
  it('installs every skill byte-identically to its template with no injected prose directive', async () => {
    const home = await temporary('ai-workflow-skill-install-');
    await install(hosts, { home });

    const templateRoot = packagePath('templates', 'skills');
    for (const templatePath of await filesUnder(templateRoot)) {
      const relativePath = relative(templateRoot, templatePath);
      const installed = await readFile(join(home, skillsRelative, relativePath), 'utf8');
      const template = await readFile(templatePath, 'utf8');
      expect(installed, `${relativePath} matches its template`).toBe(template);
      expect(installed, `${relativePath} has no injected language directive`).not.toContain(directiveHeading);
    }
  });

  it('installs every agent exactly as rendered with no injected prose directive', async () => {
    const home = await temporary('ai-workflow-agent-install-');
    await install(hosts, { home });

    for (const host of hosts) {
      for (const file of await renderHost(host)) {
        const installed = await readFile(join(home, agentsRelative(host), file.relativePath), 'utf8');
        expect(installed, `${host}/${file.relativePath} matches its rendering`).toBe(file.contents);
        expect(installed, `${host}/${file.relativePath} has no injected language directive`).not.toContain(directiveHeading);
      }
    }
  });

  it('rejects a leftover output_language key before writing any managed file', async () => {
    const home = await temporary('ai-workflow-skill-removed-config-');
    await seedConfig(home, 'output_language: zh-CN\n');

    await expect(install(hosts, { home })).rejects.toThrow(/configuration/i);

    expect((await managedTree(home)).size).toBe(0);
    expect(await readFile(join(home, configRelative), 'utf8')).toBe('output_language: zh-CN\n');
  });

  it('exposes no language configuration item and keeps config.yaml out of the manifest', async () => {
    const home = await temporary('ai-workflow-skill-schema-');
    await install(hosts, { home });

    const schema = JSON.parse(await readFile(packagePath('schemas', 'settings.schema.json'), 'utf8')) as {
      additionalProperties?: boolean;
      properties?: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties ?? {}).filter((key) => /language/i.test(key))).toEqual([]);
    expect(schema.additionalProperties, 'unknown configuration keys are rejected').toBe(false);
    expect(await readFile(join(home, manifestRelative), 'utf8')).not.toContain('config.yaml');
  });
});
