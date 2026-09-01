import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { packagePath } from '../../src/utils/schema.js';
describe('native prompt contracts', () => {
  it('gives each skill structured gates and completion checks', async () => { for (const name of ['planning', 'plan-to-tasks', 'coding']) { const text = await readFile(packagePath('templates', 'skills', name, 'SKILL.md'), 'utf8'); expect(text).toMatch(/## Outcome/); expect(text).toMatch(/## .*checklist/i); expect(text.split('\n').length).toBeGreaterThan(50); } });
  it('gives all eight roles structured permissions and output contracts', async () => { const root = packagePath('templates', 'agents'); const files = (await readdir(root)).filter((name) => name.endsWith('.md')); expect(files).toHaveLength(8); for (const name of files) { const text = await readFile(join(root, name), 'utf8'); expect(text).toMatch(/## (Mission|Mission and authority)/); expect(text).toMatch(/## (Permissions|Prohibited actions)/); expect(text).toMatch(/## Output checklist/); } });
  it('requires numbered clarification questions and explained recommended options', async () => {
    const text = await readFile(packagePath('templates', 'skills', 'planning', 'SKILL.md'), 'utf8');
    expect(text).toMatch(/问题 N：/);
    expect(text).toMatch(/问题 1：/);
    expect(text).toMatch(/across the entire clarification loop/i);
    expect(text).toMatch(/never reset/i);
    expect(text).toMatch(/1、2、3、4/);
    expect(text).toMatch(/推荐/);
    expect(text).toMatch(/解释|consequences|trade-?offs/i);
  });
  it('specifies a single spec review followed by repair without a second review', async () => {
    const text = await readFile(packagePath('templates', 'skills', 'planning', 'SKILL.md'), 'utf8');
    expect(text).toMatch(/Spec Review exactly once/i);
    expect(text).toMatch(/without invoking Spec Review again/i);
    expect(text).not.toMatch(/Spec Review passed the exact written content/i);
    const reviewer = await readFile(packagePath('templates', 'agents', 'spec-review.md'), 'utf8');
    expect(reviewer).toMatch(/must not invoke Spec Review a second time/i);
  });
  it('keeps approved planning drafts out of temporary directories while allowing digest writes in the final plan directory', async () => {
    const text = await readFile(packagePath('templates', 'skills', 'planning', 'SKILL.md'), 'utf8');
    expect(text).toMatch(/draft both documents in memory/i);
    expect(text).toMatch(/must not write.*temporary|不得写入.*临时目录/i);
    expect(text).toMatch(/spec\.md.*plan\.md.*\.ai-workflow\/plans.*plan id.*digest|\.ai-workflow\/plans.*plan id.*spec\.md.*plan\.md.*digest/is);
  });
  it('installs a message-only commit skill and routes every Git Operator commit through it', async () => {
    const messageSkill = await readFile(packagePath('templates', 'skills', 'git-message', 'SKILL.md'), 'utf8');
    expect(messageSkill).toMatch(/^name: git-message$/m);
    expect(messageSkill).toMatch(/Conventional Commits/i);
    expect(messageSkill).toMatch(/must not run any Git mutation/i);

    const operator = await readFile(packagePath('templates', 'agents', 'git-operator.md'), 'utf8');
    expect(operator).toMatch(/before every direct commit.*invoke.*\$git-message/is);

    const planning = await readFile(packagePath('templates', 'skills', 'planning', 'SKILL.md'), 'utf8');
    expect(planning).toMatch(/delegate.*Git Operator.*spec\.md.*plan\.md/is);
    expect(planning).toMatch(/automatic local commit/i);

    const tasks = await readFile(packagePath('templates', 'skills', 'plan-to-tasks', 'SKILL.md'), 'utf8');
    expect(tasks).toMatch(/delegate.*Git Operator.*task files/is);
    expect(tasks).toMatch(/automatic local commit/i);
  });
  it('keeps skill metadata and example templates inside their owning skill', async () => {
    const skillRoot = packagePath('templates', 'skills');
    const skills = (await readdir(skillRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(skills).toEqual(['coding', 'git-message', 'plan-to-tasks', 'planning', 'setup-ai-workflow', 'switch-profile']);
    for (const skill of skills) {
      const metadata = parse(await readFile(join(skillRoot, skill, 'agents', 'openai.yaml'), 'utf8')) as {
        interface?: { display_name?: string; short_description?: string; default_prompt?: string };
      };
      expect(metadata.interface?.display_name).toBeTruthy();
      expect(metadata.interface?.short_description?.length).toBeGreaterThanOrEqual(25);
      expect(metadata.interface?.short_description?.length).toBeLessThanOrEqual(64);
      expect(metadata.interface?.default_prompt).toContain(`$${skill}`);
    }

    const templates = [
      ['planning', 'spec.md', '# Specification'],
      ['planning', 'plan.md', '# Implementation Plan'],
      ['plan-to-tasks', 'task.md', '# Task'],
      ['git-message', 'commit-message.md', '# Commit Message']
    ] as const;
    for (const [skill, file, title] of templates) {
      const contents = await readFile(join(skillRoot, skill, 'references', file), 'utf8');
      expect(contents).toContain(title);
      expect(contents).toMatch(/## Example/i);
      expect(await readFile(join(skillRoot, skill, 'SKILL.md'), 'utf8')).toContain(`references/${file}`);
    }
  });
  it('documents the shared frozen-plan digest protocol in all lifecycle skills', async () => {
    const skillRoot = packagePath('templates', 'skills');
    const digest = await readFile(join(skillRoot, 'planning', 'references', 'digest.md'), 'utf8');
    expect(digest).toContain('digest: ""');
    expect(digest).toMatch(/UTF-8/);
    expect(digest).toMatch(/sha-?256/i);
    for (const skill of ['planning', 'plan-to-tasks', 'coding']) {
      const contents = await readFile(join(skillRoot, skill, 'SKILL.md'), 'utf8');
      expect(contents).toMatch(/frozen-plan digest protocol/i);
      expect(contents).toMatch(/plan validate/);
    }
  });
  it('installs navigation-first context contracts for discovery and lifecycle skills', async () => {
    const navigation = await readFile(packagePath('templates', 'project', 'navigation.md'), 'utf8');
    expect(navigation).toMatch(/Entries.*Public Symbols.*Read Scope/i);

    const explorer = await readFile(packagePath('templates', 'agents', 'file-explorer.md'), 'utf8');
    expect(explorer).toMatch(/missing_index.*miss.*stale.*invalid/is);
    expect(explorer).toMatch(/authorized module roots|allowed module roots/i);
    expect(explorer).toMatch(/navigation\.json/i);
    expect(explorer).toMatch(/context refresh/i);

    for (const skill of ['planning', 'plan-to-tasks', 'coding']) {
      const text = await readFile(packagePath('templates', 'skills', skill, 'SKILL.md'), 'utf8');
      expect(text).toMatch(/context locate/i);
      expect(text).toMatch(/navigation\.json/i);
      expect(text).toMatch(/read_scope/i);
      expect(text).toMatch(/must not.*(?:src\/|tests\/|project root)|不得.*(?:src\/|tests\/|项目根)/is);
    }
  });
});
