import { describe, expect, it } from 'vitest';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { install } from '../../src/install/index.js';
import { exists } from '../../src/utils/fs.js';
import { packagePath } from '../../src/utils/schema.js';
import { temporary } from '../helpers.js';

const BEGIN = '<!-- ai-workflow:begin -->';
const END = '<!-- ai-workflow:end -->';
const globalFiles = {
  opencode: '.config/opencode/AGENTS.md',
  claude: '.claude/CLAUDE.md',
  codex: '.codex/AGENTS.md',
  antigravity: '.gemini/AGENTS.md',
} as const;

const REQUIRED_ROLES = [
  'Planning',
  'Plan-to-tasks',
  'Coding',
  'Backend',
  'Frontend',
  'Test',
  'File Explorer',
  'Researcher',
  'Documentation Maintainer',
  'Spec Review',
  'Standards Review',
  'Git Operator',
];

async function contract(): Promise<string> {
  return readFile(packagePath('templates', 'contract', 'AGENTS.md'), 'utf8');
}
async function projectContract(): Promise<string> {
  return readFile(packagePath('templates', 'project', 'AGENTS.md'), 'utf8');
}
function blockBody(file: string): string {
  const begin = file.indexOf(BEGIN);
  const end = file.indexOf(END);
  return file.slice(begin + BEGIN.length + 1, end);
}
async function read(home: string, relative: string): Promise<string> {
  return readFile(join(home, relative), 'utf8');
}

describe('global agent guidance', () => {
  it('AC-001 installs the byte-identical short project-contract entry into every host', async () => {
    const home = await temporary('ai-workflow-global-guidance-');
    const contents = await contract();

    await install(['opencode', 'claude', 'codex', 'antigravity'], { home });

    for (const host of Object.keys(globalFiles) as Array<keyof typeof globalFiles>) {
      const file = await read(home, globalFiles[host]);
      expect(file.split(BEGIN)).toHaveLength(2);
      expect(file.split(END)).toHaveLength(2);
      expect(blockBody(file)).toBe(contents);
    }

    expect(contents).toMatch(/explicitly\s+read\s+`?\.ai-workflow\/AGENTS\.md`?/i);
    expect(contents).toMatch(/missing[\s\S]{0,160}`?\.ai-workflow\/AGENTS\.md`?[\s\S]{0,160}init\s+.*--upgrade/i);
    expect(contents).not.toMatch(/^## (?:Workflow roles|Agent Notes)$/m);
    // REQ-007 / AC-010: the global loading entry minimally clarifies that the project's own
    // `MEMORY.md` must also be explicitly read alongside the project contract.
    expect(contents, 'the global entry must require the project MEMORY read explicitly').toMatch(/MEMORY\.md/);
    expect(contents, 'the MEMORY requirement must be phrased as an explicit read or injection').toMatch(
      /(?:explicitly\s+read|read\s+or\s+inject|inject[^.\n]{0,40}MEMORY)[\s\S]{0,120}MEMORY\.md|MEMORY\.md[\s\S]{0,120}(?:explicitly\s+read|read\s+or\s+inject)/i,
    );
  });

  it('AC-010 keeps exactly one contract file under templates/contract', async () => {
    expect(await readdir(packagePath('templates', 'contract'))).toEqual(['AGENTS.md']);
  });

  it('AC-001 keeps the complete role and notes rules in the project contract template', async () => {
    const contents = await projectContract();

    expect(contents).toMatch(/\.ai-workflow\//);
    const flat = contents.replace(/\s+/g, ' ');
    expect(flat).toMatch(/(?:only|solely|appl(?:y|ies)|effective|takes effect|active)[^.]{0,160}\.ai-workflow\/|\.ai-workflow\/[^.]{0,160}(?:only|solely|appl(?:y|ies)|effective|takes effect|active)/i);

    for (const role of REQUIRED_ROLES) expect(contents).toContain(role);
    expect(contents).toMatch(/directly\s+dispatch(?:es|ing)?\s+Git\s+Operator|primary orchestrator\s+directly\s+dispatches\s+Git\s+Operator/i);
    expect(contents).toMatch(/Documentation Maintainer[\s\S]*?returns?\s+exact\s+changed\s+paths[\s\S]*?primary orchestrator/i);
    expect(contents).not.toMatch(/Documentation Maintainer[\s\S]*?delegates?\s+the\s+local\s+commit\s+to\s+Git\s+Operator|Documentation Maintainer[\s\S]*?call\s+Git\s+Operator/i);
    expect(contents).not.toMatch(/Task\s+Worker\s+(?:coordinates|delegates)|delegates\s+(?:implementation|work)\s+and\s+Git/i);
    expect(contents).not.toMatch(/\bADR\b/);
    expect(contents).toMatch(/MEMORY\.md/);

    expect(contents).toContain('changes no product code');
    expect(contents).toContain('reports exit status, evidence, skipped checks and failures truthfully');
    expect(contents).toContain('checks requirements, acceptance criteria, testability, scope, coverage and actual delivery');
    expect(contents).toContain('Standards Review checks consistency with MEMORY and its referenced notes rules');
    expect(contents).toContain('.ai-workflow/plans/<planId>/screenshot/');
    expect(contents).toContain('may search only authorized roots');
    expect(contents).toContain('never edits files or guesses paths');
    expect(contents).toContain('using public sources and citations');
  });

  it('AC-005 installs the single-source contract block into .gemini/AGENTS.md', async () => {
    const home = await temporary('ai-workflow-antigravity-guidance-');
    const contents = await contract();

    await install(['antigravity'], { home });

    const file = await read(home, '.gemini/AGENTS.md');
    expect(file.split(BEGIN)).toHaveLength(2);
    expect(file.split(END)).toHaveLength(2);
    expect(blockBody(file)).toBe(contents);
  });

  it('AC-005 preserves existing user prose outside the .gemini/AGENTS.md contract block', async () => {
    const home = await temporary('ai-workflow-antigravity-prose-');
    const original = 'user header\n\nproject-specific guidance\n';
    await mkdir(join(home, '.gemini'), { recursive: true });
    await writeFile(join(home, '.gemini/AGENTS.md'), original);

    await install(['antigravity'], { home });

    const file = await read(home, '.gemini/AGENTS.md');
    expect(file.startsWith(original)).toBe(true);
    expect(blockBody(file)).toBe(await contract());
  });

  it('AC-005 keeps exactly one contract block in .gemini/AGENTS.md after two installs', async () => {
    const home = await temporary('ai-workflow-antigravity-once-');

    await install(['antigravity'], { home });
    await install(['antigravity'], { home });

    const file = await read(home, '.gemini/AGENTS.md');
    expect(file.split(BEGIN)).toHaveLength(2);
    expect(file.split(END)).toHaveLength(2);
  });

  it('AC-005 never creates or modifies .gemini/GEMINI.md', async () => {
    const fresh = await temporary('ai-workflow-antigravity-gemini-fresh-');
    await install(['antigravity'], { home: fresh });
    expect(await exists(join(fresh, '.gemini/GEMINI.md'))).toBe(false);

    const existing = await temporary('ai-workflow-antigravity-gemini-existing-');
    await mkdir(join(existing, '.gemini'), { recursive: true });
    await writeFile(join(existing, '.gemini/GEMINI.md'), 'user-owned guidance\n');
    await install(['antigravity'], { home: existing });
    expect(await read(existing, '.gemini/GEMINI.md')).toBe('user-owned guidance\n');
  });
});
