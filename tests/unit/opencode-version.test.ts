import { describe, expect, it } from 'vitest';
import { parseOpencodeMajor, resolveOpencodeVersion } from '../../src/install/opencode-version.js';

describe('opencode version detection', () => {
  it('parses major versions from opencode --version output', () => {
    expect(parseOpencodeMajor('1.18.31\n')).toBe(1);
    expect(parseOpencodeMajor('opencode version 2.0.6')).toBe(2);
    expect(parseOpencodeMajor('')).toBeUndefined();
  });

  it('resolves explicit versions without detection and falls back to v2', async () => {
    expect(await resolveOpencodeVersion('v1')).toBe('v1');
    expect(await resolveOpencodeVersion('v2')).toBe('v2');
    expect(await resolveOpencodeVersion(undefined)).toBe('v2');
  });
});
