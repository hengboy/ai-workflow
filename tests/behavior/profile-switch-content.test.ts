import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { packagePath } from '../../src/utils/schema.js';

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

describe('switch profile skill', () => {
  it('switches through the CLI and reports every managed host installation', async () => {
    const text = await readFile(packagePath('templates', 'skills', 'switch-profile', 'SKILL.md'), 'utf8');

    expect(text).toContain('ai-workflow profile activate');
    expect(text).toContain('installations');
    expect(text).toMatch(/agents_directory/);
    expect(text).toMatch(/do not edit/i);
  });

  it('documents config.yaml active_profile, activation writes and legacy marker migration (AC-010)', async () => {
    const readme = normalize(await readFile(packagePath('README.md'), 'utf8'));

    expect(readme).toContain('~/.config/ai-workflow/config.yaml');
    expect(readme).toContain('active_profile');
    expect(readme).toMatch(/profile activate/i);
    expect(readme).toMatch(/\bwrit(?:e|es|ten|ing)?\b/i);
    expect(readme).toMatch(/active-profile/i);
    expect(readme).toMatch(/migrat/i);
    expect(readme).toMatch(/\b(?:delete|deleted|deletion|remove|removed)\b/i);
    expect(readme).not.toMatch(/is never written/i);
  });

  it('points the skill at config.yaml active_profile and forbids hand-editing (AC-012)', async () => {
    const skill = normalize(await readFile(packagePath('templates', 'skills', 'switch-profile', 'SKILL.md'), 'utf8'));

    expect(skill).toContain('config.yaml');
    expect(skill).toContain('active_profile');
    expect(skill).not.toMatch(/active-profile/i);
    expect(skill).toMatch(/do not edit|do not hand-edit|must not be (?:hand[- ]?)?edited|never (?:hand[- ]?)?edit/i);
  });
});
