import { describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadOutputLanguage } from '../../src/settings/index.js';
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
