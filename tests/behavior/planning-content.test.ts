import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { packagePath } from '../../src/utils/schema.js';
describe('native prompt contracts', () => {
  it('gives each skill structured gates and completion checks', async () => { for (const name of ['planning', 'plan-to-tasks', 'coding']) { const text = await readFile(packagePath('templates', 'skills', name, 'SKILL.md'), 'utf8'); expect(text).toMatch(/## Outcome/); expect(text).toMatch(/## .*checklist/i); expect(text.split('\n').length).toBeGreaterThan(50); } });
  it('gives all eight roles structured permissions and output contracts', async () => { const root = packagePath('templates', 'agents'); const files = (await readdir(root)).filter((name) => name.endsWith('.md')); expect(files).toHaveLength(8); for (const name of files) { const text = await readFile(join(root, name), 'utf8'); expect(text).toMatch(/## (Mission|Mission and authority)/); expect(text).toMatch(/## (Permissions|Prohibited actions)/); expect(text).toMatch(/## Output checklist/); } });
});
