import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
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
});
