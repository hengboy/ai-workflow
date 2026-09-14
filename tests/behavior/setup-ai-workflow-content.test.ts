import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { packagePath } from '../../src/utils/schema.js';

describe('setup ai-workflow skill', () => {
  it('initializes projects through ai-workflow init without update or a project manifest', async () => {
    const root = packagePath('templates', 'skills', 'setup-ai-workflow');
    const text = await readFile(`${root}/SKILL.md`, 'utf8');
    const metadata = parse(await readFile(`${root}/agents/openai.yaml`, 'utf8')) as {
      interface?: { display_name?: string; short_description?: string; default_prompt?: string };
    };

    expect(text).toMatch(/^name: setup-ai-workflow$/m);
    expect(text).toContain('ai-workflow init <project>');
    expect(text).not.toMatch(/\bupdate\b/i);
    expect(text).not.toContain('.ai-workflow/project-manifest.json');
    expect(text).toMatch(/zero exit status and parseable JSON/i);
    expect(text).toMatch(/created/i);
    expect(text).toMatch(/Do not edit/i);
    expect(metadata.interface?.display_name).toBe('Setup AI Workflow');
    expect(metadata.interface?.short_description).toBe('Initialize ai-workflow in a project.');
    expect(metadata.interface?.default_prompt).toContain('$setup-ai-workflow');
  });
});
