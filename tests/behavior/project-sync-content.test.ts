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
 *   2. The new safe shared `sync-ai-workflow` skill is shipped: incremental CLI sync, acquires
 *      the fixed public HTTPS git source with a shallow temporary clone (never a token,
 *      credential file, GitHub CLI or SSH configuration, and never a whole-file target copy),
 *      truthful report handling (freshness requires `verified`, blocking statuses stop), frozen
 *      plans never synchronized.
 *   3. Planning, coding and plan-to-tasks invoke the phase entry
 *      `ai-workflow sync-hook --host <host> --phase --project <root>` exactly once at skill
 *      start, state that later steps, phases and native events reuse the stored result, and
 *      never instruct a per-step, per-phase or per-boundary synchronization.
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
  it('AC-006/AC-013: delivers the preflight-first native entry, the safe shared sync skill and the single-start phase entry', async () => {
    const home = await temporary('ai-workflow-sync-content-');
    await install(['opencode', 'claude', 'codex'], { home, opencodeVersion: 'v1' });

    // 1. Installed global owned entry: native preflight BEFORE reading the project contract, and
    //    the single-start cadence where native events only return the stored result.
    for (const relative of hostEntries) {
      const body = ownedBlock(await readFile(join(home, relative), 'utf8'));
      expect(body, `${relative} must name the native preflight`).toMatch(/preflight/i);
      expect(body, `${relative} must name the shared native actor`).toMatch(/sync-hook/);
      expect(body).toMatch(/--host/);
      const preflight = body.search(/preflight|sync-hook/i);
      const contractRead = body.search(/read\s+`?\.ai-workflow\/AGENTS\.md`?/i);
      expect(contractRead, `${relative} must still instruct reading the project contract`).toBeGreaterThanOrEqual(0);
      expect(preflight, `${relative} must instruct native preflight before the contract read`).toBeLessThan(contractRead);
      expect(body, `${relative} must state the automatic check runs once at skill start`).toMatch(
        /once[\s\S]{0,120}(?:skill|session)[\s\S]{0,80}(?:start|begin)|(?:skill|session)[\s\S]{0,40}(?:start|begin)[\s\S]{0,120}once/i,
      );
      expect(body, `${relative} must state native events return only the stored result`).toMatch(/stored|reuse|cache/i);
      expect(body, `${relative} must state a missing check allows without a freshness claim`).toMatch(
        /(?:no|missing|absent)[^.\n]{0,12}(?:stored )?check[\s\S]{0,160}(?:no|not|without)[\s\S]{0,80}(?:fresh|claim|verif)/i,
      );
    }

    // 2. The new safe shared sync skill is shipped with its metadata.
    const syncSkill = await readFile(join(home, sharedSkill('sync-ai-workflow')), 'utf8');
    expect(syncSkill).toMatch(/^name: sync-ai-workflow$/m);
    expect(syncSkill, 'manual synchronization uses the incremental CLI').toMatch(/ai-workflow sync\b/);
    expect(syncSkill, 'incremental section patching, not a whole-file copy').toMatch(/incremental|section|patch/i);
    expect(syncSkill, 'whole-file template copying is refused').toMatch(/whole[- ]file|complete (?:template|file) copy|copy (?:the )?whole|wholesale/i);
    expect(syncSkill, 'the skill names the fixed public git address').toMatch(/https:\/\/github\.com\/hengboy\/ai-workflow\.git/);
    expect(syncSkill, 'the skill names the fixed branch').toMatch(/\bsimplify\b/);
    expect(syncSkill, 'the skill describes shallow acquisition').toMatch(/--depth|shallow/i);
    expect(syncSkill, 'the skill never documents a bearer token').not.toMatch(/GH_TOKEN|GITHUB_TOKEN/);
    expect(syncSkill, 'the report exposes proceed').toMatch(/proceed/);
    expect(syncSkill, 'the report exposes warnings').toMatch(/warnings?/);
    expect(syncSkill, 'a freshness claim requires verified').toMatch(/verified/);
    expect(syncSkill, 'blocking statuses stop ordinary work').toMatch(/conflict|failed/);
    expect(syncSkill).toMatch(/stop|block|halt|deny/i);
    expect(syncSkill, 'frozen plans are never synchronization input').toMatch(/frozen/i);
    // The manual skill receives cadence wording only: it describes the automatic single check and
    // keeps `ai-workflow sync` an explicit fresh check, but never instructs an automatic phase entry.
    expect(syncSkill, 'the manual skill states the automatic check runs once at skill start').toMatch(
      /once[\s\S]{0,160}(?:skill|session)[\s\S]{0,90}(?:start|begin)|(?:skill|session)[\s\S]{0,60}(?:start|begin)[\s\S]{0,160}once/i,
    );
    expect(syncSkill, 'the manual skill names planning, coding and plan-to-tasks as the triggers').toMatch(
      /(?=[\s\S]{0,160}planning)(?=[\s\S]{0,160}coding)(?=[\s\S]{0,160}plan-to-tasks)/i,
    );
    expect(syncSkill, 'the automatic check reuses the stored per-root result').toMatch(
      /(?:stored|reuse|cache)[\s\S]{0,160}root|root[\s\S]{0,160}(?:stored|reuse|cache)/i,
    );
    expect(syncSkill, 'the manual sync stays a fresh cache-independent check').toMatch(
      /(?:fresh|cache[- ]independent|independent[^.\n]{0,40}cache)/i,
    );
    expect(syncSkill, 'the manual skill never instructs an automatic phase invocation').not.toMatch(
      /invoke[^.\n]{0,80}sync-hook[^.\n]{0,80}--phase|automatically[^.\n]{0,60}--phase/i,
    );
    const metadata = parse(await readFile(join(home, '.agents/skills/sync-ai-workflow/agents/openai.yaml'), 'utf8')) as {
      interface?: { default_prompt?: string };
    };
    expect(metadata.interface?.default_prompt).toContain('$sync-ai-workflow');

    // 3. Single-start phase entry: planning, coding and plan-to-tasks invoke it exactly once at
    //    skill start, reuse the stored result later and never ask for a per-step or per-phase check.
    const coding = await readFile(join(home, sharedSkill('coding')), 'utf8');
    const planning = await readFile(join(home, sharedSkill('planning')), 'utf8');
    const planToTasks = await readFile(join(home, sharedSkill('plan-to-tasks')), 'utf8');
    const phaseEntryInvocation = /ai-workflow sync-hook[\s\S]{0,120}--phase[\s\S]{0,120}--project/g;
    for (const [name, text] of [['coding', coding], ['planning', planning], ['plan-to-tasks', planToTasks]] as const) {
      expect(text, `${name} must invoke the shared native actor`).toMatch(/sync-hook/);
      expect(text).toMatch(/--host/);
      expect(text).toMatch(/--phase/);
      expect(text).toMatch(/--project/);
      expect(
        (text.match(phaseEntryInvocation) ?? []).length,
        `${name} must invoke the phase entry exactly once`,
      ).toBe(1);
      expect(text, `${name} must state the check runs once when the skill session begins`).toMatch(
        /once[\s\S]{0,140}(?:skill|session)[\s\S]{0,90}(?:start|begin|begins)|(?:skill|session)[\s\S]{0,60}(?:start|begin|begins)[\s\S]{0,140}once/i,
      );
      expect(text, `${name} must state later events reuse the stored result`).toMatch(
        /(?:native|host|stdin|event)[\s\S]{0,160}(?:stored|reuse|cache)|(?:stored|reuse|cache)[\s\S]{0,160}(?:native|host|stdin|event)/i,
      );
      expect(text, `${name} must not instruct a per-step or per-phase check`).not.toMatch(
        /(?:invoke|run|sync(?:hroniz\w*)?)[^.\n]{0,100}before (?:each|every)[^.\n]{0,60}(?:step|phase)|before (?:each|every)[^.\n]{0,60}(?:step|phase)[^.\n]{0,100}(?:invoke|run|sync)/i,
      );
      expect(text, `${name} must not use per-step or per-phase cadence`).not.toMatch(
        /(?:invoke|run|sync(?:hroniz\w*)?)[^.;\n]{0,80}per[- ](?:step|phase)|per[- ](?:step|phase)[^.;\n]{0,80}(?:invoke|run|sync)/i,
      );
      expect(text, `${name} must not invoke the phase entry inside a before-each sentence`).not.toMatch(
        /before\b[^.]{0,40}\b(?:each|every)\b[^.]{0,240}sync-hook[^.]{0,140}--phase/i,
      );
    }
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

  it('AC-006/AC-008: publishes the single-start cadence in the project contract and MEMORY files', async () => {
    const published: readonly (readonly [string, string])[] = [
      ['templates/project/AGENTS.md', packagePath('templates', 'project', 'AGENTS.md')],
      ['.ai-workflow/AGENTS.md', packagePath('.ai-workflow', 'AGENTS.md')],
      ['templates/project/MEMORY.md', packagePath('templates', 'project', 'MEMORY.md')],
      ['MEMORY.md', packagePath('MEMORY.md')],
    ];
    for (const [label, path] of published) {
      const text = await readFile(path, 'utf8');
      expect(text, `${label} must state the single-start cadence`).toMatch(
        /once[\s\S]{0,120}(?:skill|session)[\s\S]{0,80}(?:start|begin)|(?:skill|session)[\s\S]{0,40}(?:start|begin)[\s\S]{0,120}once/i,
      );
      expect(text, `${label} must state native events are served from the stored result`).toMatch(
        /(?:native|host)[\s\S]{0,140}(?:stored|reuse|cache)|(?:stored|reuse|cache)[\s\S]{0,140}(?:native|host)/i,
      );
      expect(text, `${label} must not describe a per-step or per-phase check`).not.toMatch(
        /(?:invoke|run|sync(?:hroniz\w*)?)[^.\n]{0,100}before (?:each|every)[^.\n]{0,60}(?:step|phase)|before (?:each|every)[^.\n]{0,60}(?:step|phase)[^.\n]{0,100}(?:invoke|run|sync)/i,
      );
      expect(text, `${label} must not describe per-step or per-phase synchronization`).not.toMatch(
        /(?:invoke|run|sync(?:hroniz\w*)?)[^.;\n]{0,80}per[- ](?:step|phase)|per[- ](?:step|phase)[^.;\n]{0,80}(?:invoke|run|sync)/i,
      );
    }
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

    // 2. Fixed public upstream source acquired by a shallow temporary clone, never a token.
    expect(flat, 'README names the fixed source repository').toMatch(/hengboy\/ai-workflow/);
    expect(flat, 'README names the fixed branch').toMatch(/\bsimplify\b/);
    expect(flat, 'README names the fixed public git address').toMatch(/https:\/\/github\.com\/hengboy\/ai-workflow\.git/);
    expect(flat, 'README documents the shallow temporary clone acquisition').toMatch(/--depth|shallow/i);
    expect(flat, 'README never documents a bearer token').not.toMatch(/GH_TOKEN|GITHUB_TOKEN/);

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

    // 10. Single-start cadence: one automatic check per skill start, cache-only native events, a
    //     no-check allow, and a manual command that stays a fresh cache-independent check.
    expect(flat, 'README states one automatic check per skill start').toMatch(
      /once[\s\S]{0,140}(?:skill|session)[\s\S]{0,100}(?:start|begin)|(?:skill|session)[\s\S]{0,60}(?:start|begin)[\s\S]{0,140}once/i,
    );
    expect(flat, 'README names planning, coding and plan-to-tasks as the automatic triggers').toMatch(
      /(?=[\s\S]{0,160}planning)(?=[\s\S]{0,160}coding)(?=[\s\S]{0,160}plan-to-tasks)/i,
    );
    expect(flat, 'README states native events are served from the stored result').toMatch(
      /(?:native|host|stdin)[\s\S]{0,140}(?:stored|reuse|cache)/i,
    );
    expect(flat, 'README states native events issue no source request').toMatch(
      /(?:no|without|zero|never)[\s\S]{0,70}(?:source|upstream|network)[\s\S]{0,70}(?:request|retriev|access|call)|(?:source|upstream|network)[\s\S]{0,70}(?:request|retriev)[\s\S]{0,90}(?:no|none|zero)/i,
    );
    expect(flat, 'README states a missing check allows work with no freshness claim').toMatch(
      /(?:missing|no|absent)[\s\S]{0,80}(?:stored|check|cache)[\s\S]{0,160}allow[\s\S]{0,160}(?:no|not|without|never)[\s\S]{0,80}(?:fresh|claim|verif)|allow[\s\S]{0,160}(?:no|not|without|never)[\s\S]{0,80}(?:fresh|claim|verif)[\s\S]{0,160}(?:missing|no|absent|stored|check|cache)/i,
    );
    expect(flat, 'README states the manual sync stays a fresh cache-independent check').toMatch(
      /(?:fresh|cache[- ]independent|independent[\s\S]{0,40}cache)[\s\S]{0,200}ai-workflow sync|ai-workflow sync[\s\S]{0,200}(?:fresh|cache[- ]independent|independent[\s\S]{0,40}cache)/i,
    );
    expect(flat, 'README states the manual sync never replaces the stored gate decision').toMatch(
      /(?:manual|ai-workflow sync)[\s\S]{0,220}(?:never|not|no)[\s\S]{0,90}(?:replace|overwrite|clear)[\s\S]{0,90}(?:stored|gate|decision|cache)|(?:never|not|no)[\s\S]{0,90}(?:replace|overwrite|clear)[\s\S]{0,90}(?:stored|gate)[\s\S]{0,40}decision/i,
    );

    // The retired per-boundary cadence statements must be gone: a cached snapshot cannot claim
    // freshness through a boundary query, and a session, resume or user turn no longer opens a
    // new execution unit.
    expect(flat, 'README must not tie a cache freshness claim to a boundary query').not.toMatch(
      /cach[\s\S]{0,140}(?:cannot|can not|no|not|without)[\s\S]{0,140}(?:fresh|claim)[\s\S]{0,140}(?:boundar|query)|(?:boundar|query)[\s\S]{0,140}(?:fresh|claim)[\s\S]{0,140}cach/i,
    );
    expect(flat, 'README must not say a session, resume or user turn starts a new execution unit').not.toMatch(
      /(?:new session|session[- ]start|resume|user[- ]?turn|actual-root change|root[- ]change)[\s\S]{0,140}starts?[\s\S]{0,50}(?:new (?:execution )?unit|fresh (?:execution )?unit)/i,
    );
  });
});
