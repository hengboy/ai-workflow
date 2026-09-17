import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { install } from '../../src/install/index.js';
import { packagePath } from '../../src/utils/schema.js';
import { temporary } from '../helpers.js';

const BEGIN = '<!-- ai-workflow:begin -->';
const END = '<!-- ai-workflow:end -->';
const globalFiles = {
  opencode: '.config/opencode/AGENTS.md',
  claude: '.claude/CLAUDE.md',
  codex: '.codex/AGENTS.md',
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

    await install(['opencode', 'claude', 'codex'], { home });

    for (const host of Object.keys(globalFiles) as Array<keyof typeof globalFiles>) {
      const file = await read(home, globalFiles[host]);
      expect(file.split(BEGIN)).toHaveLength(2);
      expect(file.split(END)).toHaveLength(2);
      expect(blockBody(file)).toBe(contents);
    }

    expect(contents).toMatch(/explicitly\s+read\s+`?\.ai-workflow\/AGENTS\.md`?/i);
    expect(contents).toMatch(/missing[\s\S]{0,160}`?\.ai-workflow\/AGENTS\.md`?[\s\S]{0,160}init\s+.*--upgrade/i);
    expect(contents).not.toMatch(/^## (?:Workflow roles|Agent Notes)$/m);
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
});
