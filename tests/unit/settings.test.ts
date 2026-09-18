import { describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import { loadSettings, writeActiveProfile } from '../../src/settings/index.js';
import { exists } from '../../src/utils/fs.js';
import { temporary } from '../helpers.js';

function configPath(home: string): string {
  return join(home, '.config/ai-workflow/config.yaml');
}

async function seed(home: string, contents: string): Promise<void> {
  await mkdir(join(home, '.config/ai-workflow'), { recursive: true });
  await writeFile(configPath(home), contents);
}

describe('settings loader', () => {
  it('returns no settings when the configuration file is absent', async () => {
    const home = await temporary('ai-workflow-settings-load-absent-');

    await expect(loadSettings(home)).resolves.toEqual({});
  });

  it('returns no settings for empty, whitespace-only, comment-only and null documents', async () => {
    for (const contents of ['', '   \n\t\n', '# comment\n', 'null\n', '~\n']) {
      const home = await temporary('ai-workflow-settings-load-empty-');
      await seed(home, contents);

      await expect(loadSettings(home)).resolves.toEqual({});
    }
  });

  it('returns no settings when only unrelated keys are present', async () => {
    const home = await temporary('ai-workflow-settings-load-omitted-');
    await seed(home, 'version: 1\n');

    await expect(loadSettings(home)).resolves.toEqual({});
  });

  it('reads active_profile on its own', async () => {
    const home = await temporary('ai-workflow-settings-load-active-');
    await seed(home, 'active_profile: team\n');

    await expect(loadSettings(home)).resolves.toEqual({ active_profile: 'team' });
  });

  it('rejects the removed output_language key as an unknown configuration key', async () => {
    for (const contents of ['output_language: zh-CN\n', 'output_language: zh-CN\nactive_profile: team\n']) {
      const home = await temporary('ai-workflow-settings-load-removed-');
      await seed(home, contents);

      await expect(loadSettings(home)).rejects.toThrow(/configuration/i);
    }
  });

  it('rejects malformed YAML and non-object documents', async () => {
    for (const contents of ['output_language: "unterminated\n', 'fr\n', '[en]\n']) {
      const home = await temporary('ai-workflow-settings-load-invalid-');
      await seed(home, contents);

      await expect(loadSettings(home)).rejects.toThrow(/configuration/i);
    }
  });

  it('rejects an illegal active_profile and names the field', async () => {
    for (const contents of ['active_profile: 123\n', 'active_profile: ""\n', 'active_profile: ../x\n']) {
      const home = await temporary('ai-workflow-settings-load-active-invalid-');
      await seed(home, contents);

      await expect(loadSettings(home)).rejects.toThrow(/active_profile/);
    }
  });

  it('rethrows an unreadable configuration path instead of returning no settings', async () => {
    const home = await temporary('ai-workflow-settings-unreadable-');
    await mkdir(configPath(home), { recursive: true });

    await expect(loadSettings(home)).rejects.toThrow();
  });
});

describe('active profile settings writer', () => {
  it('creates config.yaml with the active profile and its parent directories', async () => {
    const home = await temporary('ai-workflow-settings-write-new-');

    await writeActiveProfile(home, 'local');

    expect(await exists(configPath(home))).toBe(true);
    expect(await loadSettings(home)).toEqual({ active_profile: 'local' });
  });

  it('preserves existing unrelated and version keys while setting the active profile', async () => {
    const home = await temporary('ai-workflow-settings-write-preserve-');
    await seed(home, 'version: 1\n');

    await writeActiveProfile(home, 'team');

    await expect(loadSettings(home)).resolves.toEqual({ active_profile: 'team' });
    const parsed = YAML.parse(await readFile(configPath(home), 'utf8')) as Record<string, unknown>;
    expect(parsed.version).toBe(1);
  });

  it('replaces an existing active profile', async () => {
    const home = await temporary('ai-workflow-settings-write-replace-');
    await seed(home, 'active_profile: first\n');

    await writeActiveProfile(home, 'second');

    expect(await loadSettings(home)).toEqual({ active_profile: 'second' });
  });
});
