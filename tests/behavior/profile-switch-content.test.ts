import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { packagePath } from '../../src/utils/schema.js';

describe('switch profile skill', () => {
  it('switches through the CLI and reports every managed host installation', async () => {
    const text = await readFile(packagePath('templates', 'skills', 'switch-profile', 'SKILL.md'), 'utf8');

    expect(text).toContain('ai-workflow profile activate');
    expect(text).toContain('installations');
    expect(text).toMatch(/agents_directory/);
    expect(text).toMatch(/Do not edit/i);
  });
});
