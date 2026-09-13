import { describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import { loadOutputLanguage, loadSettings, writeActiveProfile } from '../../src/settings/index.js';
import { exists } from '../../src/utils/fs.js';
import { temporary } from '../helpers.js';

function configPath(home: string): string {
  return join(home, '.config/ai-workflow/config.yaml');
}

async function seed(home: string, contents: string): Promise<void> {
  await mkdir(join(home, '.config/ai-workflow'), { recursive: true });
  await writeFile(configPath(home), contents);
}

describe('output language settings loader', () => {
  it('resolves to en when the configuration file is absent', async () => {
    const home = await temporary('ai-workflow-settings-absent-');

    await expect(loadOutputLanguage(home)).resolves.toBe('en');
  });

  it('resolves to en for empty, whitespace-only and comment-only files', async () => {
    for (const contents of ['', '   \n\t\n', '# comment\n']) {
      const home = await temporary('ai-workflow-settings-empty-');
      await seed(home, contents);

      await expect(loadOutputLanguage(home)).resolves.toBe('en');
    }
  });

  it('resolves to en when output_language is omitted', async () => {
    const home = await temporary('ai-workflow-settings-omitted-');
    await seed(home, 'version: 1\n');

    await expect(loadOutputLanguage(home)).resolves.toBe('en');
  });

  it('reads the supported en and zh-CN values', async () => {
    const enHome = await temporary('ai-workflow-settings-en-');
    await seed(enHome, 'output_language: en\n');
    await expect(loadOutputLanguage(enHome)).resolves.toBe('en');

    const zhHome = await temporary('ai-workflow-settings-zh-');
    await seed(zhHome, 'output_language: zh-CN\n');
    await expect(loadOutputLanguage(zhHome)).resolves.toBe('zh-CN');
  });

  it('rejects unsupported and case-mismatched values while naming both supported languages', async () => {
    for (const value of ['fr', 'zh-cn']) {
      const home = await temporary('ai-workflow-settings-unsupported-');
      await seed(home, `output_language: ${value}\n`);

      await expect(loadOutputLanguage(home)).rejects.toThrow(/configuration[\s\S]*must be one of 'en' and 'zh-CN'/i);
    }
  });

  it('rejects malformed YAML with a configuration error naming both supported languages', async () => {
    const home = await temporary('ai-workflow-settings-malformed-');
    await seed(home, 'output_language: "unterminated\n');

    await expect(loadOutputLanguage(home)).rejects.toThrow(/configuration[\s\S]*must be one of 'en' and 'zh-CN'/i);
  });

  it('rejects non-object documents such as scalars and sequences', async () => {
    for (const contents of ['fr\n', '[en]\n']) {
      const home = await temporary('ai-workflow-settings-non-object-');
      await seed(home, contents);

      await expect(loadOutputLanguage(home)).rejects.toThrow(/configuration[\s\S]*must be one of 'en' and 'zh-CN'/i);
    }
  });

  it('rethrows an unreadable configuration path instead of resolving to en', async () => {
    const home = await temporary('ai-workflow-settings-unreadable-');
    await mkdir(configPath(home), { recursive: true });

    await expect(loadOutputLanguage(home)).rejects.toThrow();
  });
});

describe('settings loader', () => {
  it('returns only the default output language when the configuration file is absent', async () => {
    const home = await temporary('ai-workflow-settings-load-absent-');

    await expect(loadSettings(home)).resolves.toEqual({ output_language: 'en' });
  });

  it('returns the default for empty, whitespace-only, comment-only and null documents', async () => {
    for (const contents of ['', '   \n\t\n', '# comment\n', 'null\n', '~\n']) {
      const home = await temporary('ai-workflow-settings-load-empty-');
      await seed(home, contents);

      await expect(loadSettings(home)).resolves.toEqual({ output_language: 'en' });
    }
  });

  it('returns the default output language when only unrelated keys are present', async () => {
    const home = await temporary('ai-workflow-settings-load-omitted-');
    await seed(home, 'version: 1\n');

    await expect(loadSettings(home)).resolves.toEqual({ output_language: 'en' });
  });

  it('reads the supported output language', async () => {
    const home = await temporary('ai-workflow-settings-load-language-');
    await seed(home, 'output_language: zh-CN\n');

    await expect(loadSettings(home)).resolves.toEqual({ output_language: 'zh-CN' });
  });

  it('reads active_profile on its own with the default output language', async () => {
    const home = await temporary('ai-workflow-settings-load-active-');
    await seed(home, 'active_profile: team\n');

    await expect(loadSettings(home)).resolves.toEqual({ output_language: 'en', active_profile: 'team' });
  });

  it('preserves active_profile and output_language when both are present', async () => {
    const home = await temporary('ai-workflow-settings-load-both-');
    await seed(home, 'output_language: zh-CN\nactive_profile: team\n');

    await expect(loadSettings(home)).resolves.toEqual({ output_language: 'zh-CN', active_profile: 'team' });
  });

  it('rejects unsupported languages, malformed YAML and non-object documents', async () => {
    for (const contents of ['output_language: fr\n', 'output_language: "unterminated\n', 'fr\n', '[en]\n']) {
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
});

describe('active profile settings writer', () => {
  it('creates config.yaml with the active profile and its parent directories', async () => {
    const home = await temporary('ai-workflow-settings-write-new-');

    await writeActiveProfile(home, 'local');

    expect(await exists(configPath(home))).toBe(true);
    expect(await loadSettings(home)).toEqual({ output_language: 'en', active_profile: 'local' });
  });

  it('preserves existing output_language and version keys', async () => {
    const home = await temporary('ai-workflow-settings-write-preserve-');
    await seed(home, 'version: 1\noutput_language: zh-CN\n');

    await writeActiveProfile(home, 'team');

    await expect(loadSettings(home)).resolves.toMatchObject({ output_language: 'zh-CN', active_profile: 'team' });
    const parsed = YAML.parse(await readFile(configPath(home), 'utf8')) as Record<string, unknown>;
    expect(parsed.version).toBe(1);
  });

  it('replaces an existing active profile', async () => {
    const home = await temporary('ai-workflow-settings-write-replace-');
    await seed(home, 'output_language: zh-CN\nactive_profile: first\n');

    await writeActiveProfile(home, 'second');

    expect(await loadSettings(home)).toEqual({ output_language: 'zh-CN', active_profile: 'second' });
  });
});
