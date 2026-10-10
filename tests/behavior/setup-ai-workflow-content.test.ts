import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { packagePath } from '../../src/utils/schema.js';

// REQ-008 / AC-016: the setup skill must distinguish a user-authorized first-time
// initialization from an explicit upgrade of an existing project, and report the
// CLI's created/skipped/failure results accurately. These assertions cover
// non-omittable entry points and constraints only; they do not prove semantic
// correctness of the generated prose.
describe('setup ai-workflow skill', () => {
  it('separates first-time init from an explicitly authorized upgrade and reports every result', async () => {
    const root = packagePath('templates', 'skills', 'setup-ai-workflow');
    const text = await readFile(`${root}/SKILL.md`, 'utf8');
    const metadata = parse(await readFile(`${root}/agents/openai.yaml`, 'utf8')) as {
      interface?: { display_name?: string; short_description?: string; default_prompt?: string };
    };

    expect(text).toMatch(/^name: setup-ai-workflow$/m);

    // First-time initialization entry point.
    expect(text).toContain('ai-workflow init <project>');
    // Explicit upgrade entry point for projects that already adopted ai-workflow.
    expect(text).toMatch(/ai-workflow init[^\n]*--upgrade/);
    expect(text).toMatch(/existing|already/i);
    expect(text).toMatch(/first[- ]time|initializ/i);

    // An upgrade is only run on explicit user authorization, never inferred.
    const authorized =
      /explicitly (?:authoriz|direct|request|ask|instruct)/i.test(text) ||
      /user(?:'s)? (?:explicit|authorization|direction|request|approval|consent)/i.test(text);
    expect(authorized, 'upgrade requires explicit user authorization').toBe(true);

    // Accurate result reporting: the CLI's created/skipped paths and a truthful failure path.
    expect(text).toMatch(/created/);
    expect(text).toMatch(/skipped/);
    expect(text).toMatch(/zero exit status and parseable JSON/i);
    expect(text).toMatch(/non-?zero|fail/i);

    // Retired surfaces stay absent.
    expect(text).not.toMatch(/\bupdate\b/i);
    expect(text).not.toContain('.ai-workflow/project-manifest.json');

    // Managed files are never edited directly.
    expect(text).toMatch(/Do not edit/i);

    expect(metadata.interface?.display_name).toBe('Setup AI Workflow');
    // The description must name the authorized upgrade path, not only first-time initialization.
    expect(metadata.interface?.short_description).toMatch(/upgrade/i);
    expect(metadata.interface?.short_description).toMatch(/explicit|authoriz/i);
    expect(metadata.interface?.default_prompt).toContain('$setup-ai-workflow');
  });

  it('requires the primary setup session to explicitly load the fixed project context before acting', async () => {
    const text = await readFile(`${packagePath('templates', 'skills', 'setup-ai-workflow')}/SKILL.md`, 'utf8');
    const fixed = {
      contract: '.ai-workflow/AGENTS.md',
      memory: 'MEMORY.md',
      navigationJson: '.ai-workflow/index/navigation.json',
      navigationMarkdown: '.ai-workflow/index/navigation.md',
    };
    // AC-010: every primary role must explicitly read or receive all four fixed contexts; a
    // Markdown link or an inherited parent read does not load them into this session.
    for (const [name, path] of Object.entries(fixed)) {
      expect(text, `setup must explicitly load the ${name} context (${path})`).toContain(path);
    }
    expect(text, 'setup must state an explicit read or complete injected context').toMatch(
      /explicitly read|read or inject|inject[^.\n]{0,60}context|complete injected/i,
    );
  });
});
