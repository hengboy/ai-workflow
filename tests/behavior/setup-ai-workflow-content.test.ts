import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { packagePath } from '../../src/utils/schema.js';

describe('setup ai-workflow skill', () => {
  it('initializes new projects and safely updates managed projects through the CLI', async () => {
    const root = packagePath('templates', 'skills', 'setup-ai-workflow');
    const text = await readFile(`${root}/SKILL.md`, 'utf8');
    const metadata = parse(await readFile(`${root}/agents/openai.yaml`, 'utf8')) as {
      interface?: { display_name?: string; short_description?: string; default_prompt?: string };
    };

    expect(text).toMatch(/^name: setup-ai-workflow$/m);
    expect(text).toContain('ai-workflow init <project>');
    expect(text).toContain('ai-workflow update <project>');
    expect(text).toContain('.ai-workflow/project-manifest.json');
    expect(text).toMatch(/manifest is absent.*first-time setup.*init/is);
    expect(text).toMatch(/manifest is present.*update/is);
    expect(text).toMatch(/zero exit status and parseable JSON/i);
    expect(text).toMatch(/report `updated`, `unchanged`, and `skipped`/i);
    expect(text).toMatch(/was modified by the project user.*leave it unchanged/i);
    expect(text).toMatch(/Do not edit/i);
    expect(text).toMatch(/explicitly requested an update.*do not run `init` or create a manifest/is);
    expect(text).toMatch(/merged manually/i);
    expect(metadata.interface?.display_name).toBe('Setup AI Workflow');
    expect(metadata.interface?.short_description).toBe('Initialize or safely update an ai-workflow project.');
    expect(metadata.interface?.default_prompt).toContain('$setup-ai-workflow');
  });
});
