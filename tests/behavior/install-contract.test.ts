import { describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { install } from '../../src/install/index.js';
import { sha256 } from '../../src/utils/hash.js';
import { packagePath } from '../../src/utils/schema.js';
import { temporary } from '../helpers.js';

const BEGIN = '<!-- ai-workflow:begin -->';
const END = '<!-- ai-workflow:end -->';
const manifestRelative = '.config/ai-workflow/install-manifest.json';
const globalFiles = {
  opencode: '.config/opencode/AGENTS.md',
  claude: '.claude/CLAUDE.md',
  codex: '.codex/AGENTS.md',
} as const;
type ContractHost = keyof typeof globalFiles;

interface ContractRecord { path: string; digest: string; created: boolean }
interface DiskManifest { contracts?: Partial<Record<ContractHost, ContractRecord>> }

async function template(): Promise<string> {
  return readFile(packagePath('templates', 'contract', 'AGENTS.md'), 'utf8');
}
function block(contents: string): string {
  return `${BEGIN}\n${contents}${END}`;
}
function body(file: string): string {
  const begin = file.indexOf(BEGIN);
  const end = file.indexOf(END);
  return file.slice(begin + BEGIN.length + 1, end);
}
async function manifest(home: string): Promise<DiskManifest> {
  return JSON.parse(await readFile(join(home, manifestRelative), 'utf8')) as DiskManifest;
}
async function read(home: string, relative: string): Promise<string> {
  return readFile(join(home, relative), 'utf8');
}

describe('user-level contract installation', () => {
  it('AC-003 creates the marker block and a created:true record when the global file is absent', async () => {
    const home = await temporary();
    const contents = await template();
    const expected = block(contents);

    const result = await install(['opencode'], { home });

    const file = await read(home, globalFiles.opencode);
    expect(file).toBe(`${expected}\n`);
    expect(file.endsWith('\n')).toBe(true);
    expect(result.skipped ?? []).not.toContain(globalFiles.opencode);
    expect((await manifest(home)).contracts?.opencode).toEqual({
      path: globalFiles.opencode,
      digest: sha256(expected),
      created: true,
    });
  });

  it.each([
    ['with a trailing newline', 'user notes\n'],
    ['without a trailing newline', 'user notes'],
  ])('AC-004 appends the block after existing user text %s and records created:false', async (_label, original) => {
    const home = await temporary();
    const contents = await template();
    const expected = block(contents);
    await mkdir(join(home, '.config/opencode'), { recursive: true });
    await writeFile(join(home, globalFiles.opencode), original);

    await install(['opencode'], { home });

    const separator = original.endsWith('\n') ? '' : '\n';
    const file = await read(home, globalFiles.opencode);
    expect(file).toBe(`${original}${separator}${expected}\n`);
    expect(file.startsWith(original)).toBe(true);
    expect((await manifest(home)).contracts?.opencode).toMatchObject({
      path: globalFiles.opencode,
      digest: sha256(expected),
      created: false,
    });
  });

  it('AC-005 installs the identical single-source contract body into every host', async () => {
    const home = await temporary();
    const contents = await template();

    await install(['opencode', 'claude', 'codex'], { home });

    for (const host of Object.keys(globalFiles) as ContractHost[]) {
      const file = await read(home, globalFiles[host]);
      expect(file.split(BEGIN)).toHaveLength(2);
      expect(file.split(END)).toHaveLength(2);
      expect(body(file)).toBe(contents);
      expect(body(file).endsWith('\n')).toBe(true);
    }
  });

  it('AC-006 refreshes a recorded unmodified block to the current template and preserves outside bytes', async () => {
    const home = await temporary();
    const contents = await template();
    const current = block(contents);
    const outdated = block('outdated contract text\n');
    const filePath = globalFiles.opencode;
    await mkdir(join(home, '.config/opencode'), { recursive: true });
    const composed = `before\n${outdated}\nafter\n`;
    await writeFile(join(home, filePath), composed);
    await mkdir(join(home, '.config/ai-workflow'), { recursive: true });
    await writeFile(join(home, manifestRelative), `${JSON.stringify({
      version: '0.1.0',
      installed_at: new Date(0).toISOString(),
      hosts: {},
      contracts: { opencode: { path: filePath, digest: sha256(outdated), created: false } },
    }, null, 2)}\n`);
    const beginIndex = composed.indexOf(BEGIN);
    const endIndex = composed.indexOf(END);

    await install(['opencode'], { home });

    const expected = composed.slice(0, beginIndex) + current + composed.slice(endIndex + END.length);
    const file = await read(home, filePath);
    expect(file).toBe(expected);
    expect(file).toBe(`before\n${current}\nafter\n`);
    expect(file.split(BEGIN)).toHaveLength(2);
    expect(file.split(END)).toHaveLength(2);
    expect((await manifest(home)).contracts?.opencode?.digest).toBe(sha256(current));
  });

  it('AC-007 skips a hand-edited block, leaving its bytes and recorded digest untouched', async () => {
    const home = await temporary();
    await install(['opencode'], { home });
    const before = await read(home, globalFiles.opencode);
    const recordBefore = (await manifest(home)).contracts?.opencode;
    const edited = before.replace(`${BEGIN}\n`, `${BEGIN}\nhand edited `);
    await writeFile(join(home, globalFiles.opencode), edited);

    const result = await install(['opencode'], { home });

    expect(result.skipped ?? []).toContain(globalFiles.opencode);
    expect(await read(home, globalFiles.opencode)).toBe(edited);
    expect((await manifest(home)).contracts?.opencode).toEqual(recordBefore);
  });

  it('AC-008 adopts a valid unowned block and records it with created:false', async () => {
    const home = await temporary();
    const contents = await template();
    const current = block(contents);
    const unowned = block('unowned contract text\n');
    await mkdir(join(home, '.config/opencode'), { recursive: true });
    await writeFile(join(home, globalFiles.opencode), `prefix\n${unowned}\n`);

    await install(['opencode'], { home });

    const file = await read(home, globalFiles.opencode);
    expect(file).toBe(`prefix\n${current}\n`);
    expect(file.split(BEGIN)).toHaveLength(2);
    expect((await manifest(home)).contracts?.opencode).toEqual({
      path: globalFiles.opencode,
      digest: sha256(current),
      created: false,
    });
  });

  it.each([
    ['two ordered blocks', `${block('first\n')}\n${block('second\n')}\n`],
    ['only a begin marker', `prefix\n${BEGIN}\nno end marker\n`],
    ['only an end marker', `prefix\n${END}\nno begin marker\n`],
  ])('AC-014 refuses malformed or duplicate markers (%s) without changing bytes', async (_label, original) => {
    const home = await temporary();
    await mkdir(join(home, '.config/opencode'), { recursive: true });
    await writeFile(join(home, globalFiles.opencode), original);

    const result = await install(['opencode'], { home });

    expect(result.skipped ?? []).toContain(globalFiles.opencode);
    expect(await read(home, globalFiles.opencode)).toBe(original);
    expect((await manifest(home)).contracts?.opencode).toBeUndefined();
  });
});
