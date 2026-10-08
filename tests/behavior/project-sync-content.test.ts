import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { install } from '../../src/install/index.js';
import { packagePath } from '../../src/utils/schema.js';
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

/**
 * Published-documentation boundary for slice 3 rollout (AC-006 authority reload / AC-013
 * truthful published behavior). This reads only the user-consumed `README.md` and asserts the
 * semantics a reader must be able to rely on. It deliberately checks behavior-level meaning,
 * not exact phrases or the private module layout, so prose may be reworded as long as the
 * documented contract holds.
 */
describe('project synchronization published documentation', () => {
  it('AC-006/AC-013: the public README documents incremental, warning-aware synchronization rather than template copying', async () => {
    const readme = await readFile(packagePath('README.md'), 'utf8');
    const flat = readme.replace(/\s+/g, ' ');

    // 1. Incremental CLI, including check mode.
    expect(flat, 'README documents the incremental sync command').toMatch(/ai-workflow sync\b/);
    expect(flat, 'README documents check mode').toMatch(/--check/);

    // 2. Fixed upstream source and explicit bearer credentials (GH_TOKEN before GITHUB_TOKEN).
    expect(flat, 'README names the fixed source repository').toMatch(/hengboy\/ai-workflow/);
    expect(flat, 'README names the fixed branch').toMatch(/\bsimplify\b/);
    expect(flat, 'README documents GH_TOKEN').toMatch(/GH_TOKEN/);
    expect(flat, 'README documents GITHUB_TOKEN').toMatch(/GITHUB_TOKEN/);
    expect(readme.indexOf('GH_TOKEN'), 'README documents GH_TOKEN before GITHUB_TOKEN').toBeLessThan(
      readme.indexOf('GITHUB_TOKEN'),
    );

    // 3. Truthful statuses, verified/proceed, exit codes, and warning continuation with no freshness claim.
    for (const status of ['synchronized', 'unverified', 'needs_attention', 'pending', 'conflict', 'failed']) {
      expect(flat, `README documents the ${status} status`).toMatch(new RegExp(`\\b${status}\\b`));
    }
    expect(flat, 'README exposes the verified flag').toMatch(/\bverified\b/);
    expect(flat, 'README exposes the proceed flag').toMatch(/\bproceed\b/);
    expect(
      flat,
      'README maps the synchronized/warning/blocking statuses to exit codes 0/2/1',
    ).toMatch(/\b0\b[\s\S]{0,160}\b2\b[\s\S]{0,160}\b1\b/);
    expect(
      flat,
      'README explains that warning results allow continuation without claiming freshness',
    ).toMatch(
      /(?:warning|unverified|needs_attention)[\s\S]{0,220}(?:continue|proceed|allow|permit)[\s\S]{0,220}(?:no|not|without|never)[\s\S]{0,90}(?:fresh|current|verified)|(?:no|not|without|never)[\s\S]{0,90}(?:fresh|current)[\s\S]{0,140}(?:claim|verified|guarantee)/i,
    );
    expect(flat, 'README states that partial or unverified results are not current').toMatch(
      /(?:partial|unverified|warning)[\s\S]{0,180}(?:not|never|no)[\s\S]{0,70}(?:current|fresh|verified|complete)/i,
    );

    // 4. Local upgrade is distinct from the remote source and makes no upstream freshness claim.
    expect(flat, 'README documents the upgrade path').toMatch(/--upgrade/);
    expect(flat, 'README distinguishes shipped/local templates from the remote source').toMatch(
      /shipped|local[\s-]?(?:project[\s-]?)?templates?/i,
    );
    expect(flat, 'README says local upgrade makes no upstream freshness claim').toMatch(
      /(?:upgrade|local)[\s\S]{0,220}(?:no|not|never|without)[\s\S]{0,90}(?:upstream|remote)[\s\S]{0,90}(?:fresh|verified|claim)|(?:no|not|never|without)[\s\S]{0,90}(?:upstream|remote)[\s\S]{0,90}(?:fresh|claim)[\s\S]{0,90}(?:upgrade|local)/i,
    );

    // 5. File strategies: project data is preserved and never treated as template input.
    for (const artifact of [
      'navigation',
      'notes?',
      'archive',
      'frozen',
      'project\\.yml',
      'AGENTS\\.md|CLAUDE\\.md|root (?:user )?instructions?',
    ]) {
      expect(flat, `README lists "${artifact}" as project-owned content`).toMatch(new RegExp(artifact, 'i'));
    }
    expect(flat, 'README states project-owned content is preserved').toMatch(
      /preserv|retain|never[\s\S]{0,50}(?:overwrite|rewrite|replace|touch)|unchanged|byte[- ]for[- ]byte/i,
    );

    // 6. Ownership markers, legacy adoption warnings, no baseline, and no whole-file copy.
    expect(flat, 'README describes the ownership section markers').toMatch(
      /ownership (?:marker|section)|owned section|section marker|ai-workflow:section/i,
    );
    expect(flat, 'README warns on differing unmarked legacy content instead of duplicating it').toMatch(
      /unmarked|legacy[\s\S]{0,180}(?:differ|mismatch|warning|attention)/i,
    );
    expect(flat, 'README states that no previous-template baseline is stored').toMatch(
      /no (?:stored )?(?:previous[\s-]?)?(?:template )?baseline|without[\s\S]{0,50}baseline|never[\s\S]{0,50}baseline/i,
    );
    expect(flat, 'README refuses whole-file template copying').toMatch(
      /(?:never|not|no|without|refus)[\s\S]{0,70}(?:whole[\s-]?file|wholesale|complete(?: template| file)? copy)|(?:whole[\s-]?file|wholesale)[\s\S]{0,70}(?:never|not|refus|avoid)/i,
    );

    // 7. Truthful enablement: host entry, trust, restart, and disabled/unloaded entries are not active.
    expect(flat, 'README documents the native host preflight entry').toMatch(/sync-hook/);
    expect(flat, 'README documents the phase/project host-entry form').toMatch(
      /--phase[\s\S]{0,90}--project|--project[\s\S]{0,90}--phase/,
    );
    expect(flat, 'README names Codex hook trust').toMatch(/trust/i);
    expect(flat, 'README names the OpenCode restart step').toMatch(/restart/i);
    expect(flat, 'README names disabled/untrusted/unloaded entries as not active').toMatch(
      /(?:disabled|untrusted|unloaded)[\s\S]{0,180}(?:not active|inactive|not automatic|enforcement limitation)|(?:not active|inactive)[\s\S]{0,180}(?:disabled|untrusted|unloaded)/i,
    );

    // 8. Dirty path disclosure and frozen-scope collision escalation, without silent staging.
    expect(flat, 'README discloses created and updated paths').toMatch(
      /created[\s\S]{0,90}updated|updated[\s\S]{0,90}created/i,
    );
    expect(flat, 'README discloses uncommitted/dirty synchronization paths').toMatch(/uncommitted|dirty/i);
    expect(flat, 'README escalates a frozen-scope collision instead of broadening authority').toMatch(
      /(?:scope|frozen)[\s\S]{0,180}(?:collision|conflict)[\s\S]{0,180}(?:support request|escalat|bounded|stop|do(?:es)? not)|(?:support request|escalat)[\s\S]{0,180}(?:scope|frozen)[\s\S]{0,90}(?:collision|conflict)/i,
    );

    // 9. One-time explicit resolution of an unowned/shadowing host skill; never a blind delete.
    expect(flat, 'README names the duplicate/shadow skill condition').toMatch(
      /(?:duplicate|shadow)[\s\S]{0,90}skill|skill[\s\S]{0,90}(?:duplicate|shadow)/i,
    );
    expect(flat, 'README requires explicit user resolution rather than automatic cleanup').toMatch(
      /explicit[\s\S]{0,180}(?:resolv|remove|cleanup|clean up)|(?:resolv|remov|cleanup|clean up)[\s\S]{0,180}explicit/i,
    );
    expect(flat, 'README refuses a blind delete of an unowned skill').toMatch(
      /(?:never|not|no|without|does not)[\s\S]{0,70}delet[\s\S]{0,90}unowned|unowned[\s\S]{0,90}(?:never|not|no|without|does not)[\s\S]{0,50}delet/i,
    );
  });
});
