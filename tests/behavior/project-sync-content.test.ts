import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { install } from '../../src/install/index.js';
import { temporary } from '../helpers.js';

/**
 * Frozen shipped-instruction contract for slice 2.10 (AC-006 phase bridge / AC-013 truthful
 * enablement). The test performs a real `install` into a disposable HOME and reads only the
 * public deliverables a host actually consumes:
 *
 *   - the owned global entry block (`<!-- ai-workflow:begin -->` … `<!-- ai-workflow:end -->`)
 *     in `.config/opencode/AGENTS.md`, `.claude/CLAUDE.md`, `.codex/AGENTS.md`;
 *   - the shared skills under `.agents/skills/<name>/SKILL.md` (+ `agents/openai.yaml`).
 *
 * Required semantics asserted here (ordering/decision contracts, not exact constants):
 *   1. The installed entry instructs the native preflight BEFORE reading the project contract.
 *   2. The new safe shared `sync-ai-workflow` skill is shipped: incremental CLI sync, never a
 *      clone/build/whole-file copy, `GH_TOKEN` documented before `GITHUB_TOKEN`, truthful
 *      report handling (freshness requires `verified`, blocking statuses stop), frozen plans
 *      never synchronized.
 *   3. Coding/planning invoke `ai-workflow sync-hook --host <host> --phase --project <root>`
 *      before each unsplit step / each frozen phase, reuse the shared child snapshot, re-read
 *      or inject updated authority, and escalate scope collisions instead of broadening scope.
 *   4. Setup keeps first adoption and upgrade manually authorized while the installed entry
 *      grants only the narrow routine-preflight exception and performs no Git.
 *   5. Enablement is truthful: Codex trust, OpenCode restart and duplicate/shadow skills are named.
 */
const BEGIN = '<!-- ai-workflow:begin -->';
const END = '<!-- ai-workflow:end -->';

const hostEntries = ['.config/opencode/AGENTS.md', '.claude/CLAUDE.md', '.codex/AGENTS.md'] as const;
const sharedSkill = (name: string): string => `.agents/skills/${name}/SKILL.md`;

function ownedBlock(file: string): string {
  const begin = file.indexOf(BEGIN);
  const end = file.indexOf(END);
  expect(begin, 'the installed global entry must carry an owned block').toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(begin);
  return file.slice(begin + BEGIN.length, end);
}

describe('project synchronization shipped instructions', () => {
  it('AC-006/AC-013: delivers the preflight-first native entry, the safe shared sync skill and the phase bridge', async () => {
    const home = await temporary('ai-workflow-sync-content-');
    await install(['opencode', 'claude', 'codex'], { home, opencodeVersion: 'v1' });

    // 1. Installed global owned entry: native preflight BEFORE reading the project contract.
    for (const relative of hostEntries) {
      const body = ownedBlock(await readFile(join(home, relative), 'utf8'));
      expect(body, `${relative} must name the native preflight`).toMatch(/preflight/i);
      expect(body, `${relative} must name the shared native actor`).toMatch(/sync-hook/);
      expect(body).toMatch(/--host/);
      const preflight = body.search(/preflight|sync-hook/i);
      const contractRead = body.search(/read\s+`?\.ai-workflow\/AGENTS\.md`?/i);
      expect(contractRead, `${relative} must still instruct reading the project contract`).toBeGreaterThanOrEqual(0);
      expect(preflight, `${relative} must instruct native preflight before the contract read`).toBeLessThan(contractRead);
    }

    // 2. The new safe shared sync skill is shipped with its metadata.
    const syncSkill = await readFile(join(home, sharedSkill('sync-ai-workflow')), 'utf8');
    expect(syncSkill).toMatch(/^name: sync-ai-workflow$/m);
    expect(syncSkill, 'manual synchronization uses the incremental CLI').toMatch(/ai-workflow sync\b/);
    expect(syncSkill, 'incremental section patching, not a clone/build/whole-file copy').toMatch(/incremental|section|patch/i);
    expect(syncSkill, 'clone/build are explicitly refused').toMatch(/never[^.\n]{0,80}(?:clone|build)|do(?:es)? not[^.\n]{0,60}(?:clone|build)|without[^.\n]{0,40}(?:clone|build)/i);
    expect(syncSkill, 'whole-file template copying is refused').toMatch(/whole[- ]file|complete (?:template|file) copy|copy (?:the )?whole|wholesale/i);
    expect(syncSkill).toMatch(/GH_TOKEN/);
    expect(syncSkill).toMatch(/GITHUB_TOKEN/);
    expect(syncSkill.indexOf('GH_TOKEN'), 'GH_TOKEN must be documented before GITHUB_TOKEN').toBeLessThan(syncSkill.indexOf('GITHUB_TOKEN'));
    expect(syncSkill, 'the report exposes proceed').toMatch(/proceed/);
    expect(syncSkill, 'the report exposes warnings').toMatch(/warnings?/);
    expect(syncSkill, 'a freshness claim requires verified').toMatch(/verified/);
    expect(syncSkill, 'blocking statuses stop ordinary work').toMatch(/conflict|failed/);
    expect(syncSkill).toMatch(/stop|block|halt|deny/i);
    expect(syncSkill, 'frozen plans are never synchronization input').toMatch(/frozen/i);
    const metadata = parse(await readFile(join(home, '.agents/skills/sync-ai-workflow/agents/openai.yaml'), 'utf8')) as {
      interface?: { default_prompt?: string };
    };
    expect(metadata.interface?.default_prompt).toContain('$sync-ai-workflow');

    // 3. Phase bridge: coding and planning invoke the same native actor and reuse the snapshot.
    const coding = await readFile(join(home, sharedSkill('coding')), 'utf8');
    const planning = await readFile(join(home, sharedSkill('planning')), 'utf8');
    for (const [name, text] of [['coding', coding], ['planning', planning]] as const) {
      expect(text, `${name} must invoke the shared native actor`).toMatch(/sync-hook/);
      expect(text).toMatch(/--host/);
      expect(text).toMatch(/--phase/);
      expect(text).toMatch(/--project/);
      expect(text, `${name} must reuse the shared child snapshot`).toMatch(/reuse|snapshot/i);
    }
    expect(coding, 'unsplit plans check before each implementation step').toMatch(/before[^\n]{0,90}step|each[^\n]{0,60}step/i);
    expect(planning, 'planning checks before each frozen phase').toMatch(/before[^\n]{0,90}phase|each[^\n]{0,70}phase/i);
    expect(coding + planning, 'updated authority is re-read or injected before ordinary work').toMatch(/re-?read|reload|inject/i);
    expect(coding + planning, 'scope collisions escalate instead of broadening scope').toMatch(/scope/i);

    // 4. Setup stays manually authorized; the installed entry is only the narrow preflight exception.
    const setup = await readFile(join(home, sharedSkill('setup-ai-workflow')), 'utf8');
    expect(setup).toMatch(/explicit/i);
    expect(setup).toMatch(/first[- ]time|initializ/i);
    expect(setup, 'setup must mention the narrow routine-preflight exception explicitly').toMatch(/preflight|sync-hook/);
    expect(setup, 'the preflight exception covers management files only').toMatch(/management/i);
    expect(setup, 'no host or synchronization step runs Git').toMatch(/no Git|without Git|never[^.\n]{0,40}Git|not[^.\n]{0,30}Git/i);

    // 5. Truthful enablement: trust/restart/duplicate conditions are named, never auto-applied.
    const enablement = syncSkill + coding + setup;
    expect(enablement).toMatch(/trust/i);
    expect(enablement).toMatch(/restart/i);
    expect(enablement).toMatch(/duplicate|shadow/i);
  });
});
