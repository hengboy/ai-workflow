import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { packagePath } from '../../src/utils/schema.js';
describe('native prompt contracts', () => {
  it('gives each skill structured gates and completion checks', async () => {
    for (const name of ['planning', 'plan-to-tasks', 'coding']) {
      const text = await readFile(packagePath('templates', 'skills', name, 'SKILL.md'), 'utf8');
      if (name !== 'coding') expect(text).toMatch(/## Outcome/);
      expect(text).toMatch(/## .*checklist/i);
      expect(text.split('\n').length).toBeGreaterThan(50);
    }
  });
  it('gives all nine roles structured permissions and output contracts', async () => { const root = packagePath('templates', 'agents'); const files = (await readdir(root)).filter((name) => name.endsWith('.md')); expect(files).toHaveLength(9); for (const name of files) { const text = await readFile(join(root, name), 'utf8'); expect(text).toMatch(/## (Mission|Mission and authority)/); expect(text).toMatch(/## (Permissions|Prohibited actions)/); expect(text).toMatch(/## Output checklist/); } });
  it('requires numbered clarification questions and explained recommended options', async () => {
    const text = await readFile(packagePath('templates', 'skills', 'planning', 'SKILL.md'), 'utf8');
    expect(text).toMatch(/问题 N：/);
    expect(text).toMatch(/问题 1：/);
    expect(text).toMatch(/across the entire clarification loop/i);
    expect(text).toMatch(/never reset/i);
    expect(text).toMatch(/1、2、3、4/);
    expect(text).toMatch(/推荐/);
    expect(text).toMatch(/解释|consequences|trade-?offs/i);
  });
  it('gates clarification questions on core business impact and resolves routine choices independently', async () => {
    const text = await readFile(packagePath('templates', 'skills', 'planning', 'SKILL.md'), 'utf8');
    expect(text).toMatch(/business-relevance gate/i);
    expect(text).toMatch(/core user workflow|domain rule|data meaning/i);
    expect(text).toMatch(/Do not ask about naming.*file locations.*framework or library choice/is);
    expect(text).toMatch(/Resolve low-impact.*yourself/i);
    expect(text).toMatch(/Do not present options merely to outsource an engineering decision/i);
    expect(text).toMatch(/stop asking questions.*complete confirmation preview/i);
  });
  it('specifies a single spec review followed by repair without a second review', async () => {
    const text = await readFile(packagePath('templates', 'skills', 'planning', 'SKILL.md'), 'utf8');
    expect(text).toMatch(/Spec Review exactly once/i);
    expect(text).toMatch(/without invoking Spec Review again/i);
    expect(text).not.toMatch(/Spec Review passed the exact written content/i);
    const reviewer = await readFile(packagePath('templates', 'agents', 'spec-review.md'), 'utf8');
    expect(reviewer).toMatch(/must not invoke Spec Review a second time/i);
  });
  it('keeps approved planning drafts out of temporary directories while allowing digest writes in the final plan directory', async () => {
    const text = await readFile(packagePath('templates', 'skills', 'planning', 'SKILL.md'), 'utf8');
    expect(text).toMatch(/draft both documents in memory/i);
    expect(text).toMatch(/must not write.*temporary|不得写入.*临时目录/i);
    expect(text).toMatch(/spec\.md.*plan\.md.*\.ai-workflow\/plans.*plan id.*digest|\.ai-workflow\/plans.*plan id.*spec\.md.*plan\.md.*digest/is);
  });
  it('installs a message-only commit skill while planning and plan-to-tasks leave gitignored artifacts uncommitted', async () => {
    const messageSkill = await readFile(packagePath('templates', 'skills', 'git-message', 'SKILL.md'), 'utf8');
    expect(messageSkill).toMatch(/^name: git-message$/m);
    expect(messageSkill).toMatch(/Conventional Commits/i);
    expect(messageSkill).toMatch(/must not run any Git mutation/i);

    const operator = await readFile(packagePath('templates', 'agents', 'git-operator.md'), 'utf8');
    expect(operator).toMatch(/before every direct commit.*invoke.*\$git-message/is);

    for (const name of ['planning', 'plan-to-tasks']) {
      const text = await readFile(packagePath('templates', 'skills', name, 'SKILL.md'), 'utf8');
      expect(text).toMatch(/gitignored/i);
      expect(text).toMatch(/do not stage or commit/i);
      expect(text).not.toMatch(/automatic local commit/i);
      expect(text).not.toMatch(/directly\s+dispatch(?:es|ed)?\s+Git\s+Operator/i);
    }
  });
  it('keeps skill metadata and example templates inside their owning skill', async () => {
    const skillRoot = packagePath('templates', 'skills');
    const skills = (await readdir(skillRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(skills).toEqual(['coding', 'git-message', 'plan-to-tasks', 'planning', 'setup-ai-workflow', 'switch-profile']);
    for (const skill of skills) {
      const metadata = parse(await readFile(join(skillRoot, skill, 'agents', 'openai.yaml'), 'utf8')) as {
        interface?: { display_name?: string; short_description?: string; default_prompt?: string };
      };
      expect(metadata.interface?.display_name).toBeTruthy();
      expect(metadata.interface?.short_description?.length).toBeGreaterThanOrEqual(25);
      expect(metadata.interface?.short_description?.length).toBeLessThanOrEqual(64);
      expect(metadata.interface?.default_prompt).toContain(`$${skill}`);
    }

    const templates = [
      ['planning', 'spec.md', '# Specification'],
      ['planning', 'plan.md', '# Implementation Plan'],
      ['plan-to-tasks', 'task.md', '# Task'],
      ['git-message', 'commit-message.md', '# Commit Message']
    ] as const;
    for (const [skill, file, title] of templates) {
      const contents = await readFile(join(skillRoot, skill, 'references', file), 'utf8');
      expect(contents).toContain(title);
      expect(contents).toMatch(/## Example/i);
      expect(await readFile(join(skillRoot, skill, 'SKILL.md'), 'utf8')).toContain(`references/${file}`);
    }
  });
  it('requires plan steps to name a Responsible role without task surface routing', async () => {
    const planTemplate = await readFile(packagePath('templates', 'skills', 'planning', 'references', 'plan.md'), 'utf8');
    const step = planTemplate.match(/### Step 1[\s\S]*?(?=\n## |$)/i)?.[0] ?? '';

    expect(step).toMatch(/^- Responsible role:\s*`?[^\n`]+`?/im);
    expect(step).not.toMatch(/^- surface:/im);
    expect(planTemplate).not.toMatch(/^surface:/im);
  });
  it('requires cohesive, priority-ordered decomposition without over-fine steps or tasks', async () => {
    const planning = await readFile(packagePath('templates', 'skills', 'planning', 'SKILL.md'), 'utf8');
    expect(planning).toMatch(/## Step granularity/);
    expect(planning).toMatch(/cohesive, independently verifiable outcomes/i);
    expect(planning).toMatch(/dependency and priority/i);
    expect(planning).toMatch(/Never over-decompose: every step adds a delegation, a verification and a commit/i);
    expect(planning).toMatch(/merge work that shares one outcome, one responsible role and one validation command/i);

    const planToTasks = await readFile(packagePath('templates', 'skills', 'plan-to-tasks', 'SKILL.md'), 'utf8');
    expect(planToTasks).toMatch(/relatedness, priority or dependency/i);
    expect(planToTasks).toMatch(/Never over-decompose: every task adds a delegation, a verification and a commit/i);
    expect(planToTasks).toMatch(/merge changes that share one outcome, one surface and one validation command/i);

    const planReference = await readFile(packagePath('templates', 'skills', 'planning', 'references', 'plan.md'), 'utf8');
    expect(planReference).toMatch(/cohesive and priority-ordered/i);
    expect(planReference).toMatch(/per-file or mechanical steps that only add execution overhead/i);

    const taskReference = await readFile(packagePath('templates', 'skills', 'plan-to-tasks', 'references', 'task.md'), 'utf8');
    expect(taskReference).toMatch(/per-file or mechanical edit/i);
    expect(taskReference).toMatch(/merge work that shares one outcome, surface and validation command/i);
  });
  it('documents the shared frozen-plan digest protocol in all lifecycle skills', async () => {
    const skillRoot = packagePath('templates', 'skills');
    const digest = await readFile(join(skillRoot, 'planning', 'references', 'digest.md'), 'utf8');
    expect(digest).toContain('digest: ""');
    expect(digest).toMatch(/UTF-8/);
    expect(digest).toMatch(/sha-?256/i);
    for (const skill of ['planning', 'plan-to-tasks']) {
      const contents = await readFile(join(skillRoot, skill, 'SKILL.md'), 'utf8');
      expect(contents).toMatch(/frozen-plan digest protocol/i);
      expect(contents).toMatch(/plan validate/);
    }
  });
  it('installs navigation-first context contracts for discovery and lifecycle skills', async () => {
    const navigation = await readFile(packagePath('templates', 'project', 'navigation.md'), 'utf8');
    expect(navigation).toMatch(/Entries.*Public Symbols.*Read Scope/i);

    const explorer = await readFile(packagePath('templates', 'agents', 'file-explorer.md'), 'utf8');
    expect(explorer).toMatch(/missing_index.*miss.*stale.*invalid/is);
    expect(explorer).toMatch(/authorized module roots|allowed module roots/i);
    expect(explorer).toMatch(/navigation\.json/i);
    expect(explorer).toMatch(/may only read files and search authorized paths/i);
    expect(explorer).toMatch(/## Status.*## Summary.*## Evidence.*## Support Requests/is);
    expect(explorer).toMatch(/Found Paths/i);
    expect(explorer).toMatch(/(?:Do not|Never|must not|禁止).{0,80}JSON envelope/i);
    expect(explorer).not.toContain('schemas/result.schema.json');
    expect(explorer).not.toMatch(/result envelope/i);
    expect(explorer).not.toContain('changed_paths');

    for (const skill of ['planning', 'plan-to-tasks']) {
      const text = await readFile(packagePath('templates', 'skills', skill, 'SKILL.md'), 'utf8');
      expect(text).toMatch(/context locate/i);
      expect(text).toMatch(/navigation\.json/i);
      expect(text).toMatch(/read_scope/i);
      expect(text).toMatch(/must not.*(?:src\/|tests\/|project root)|不得.*(?:src\/|tests\/|项目根)/is);
    }
  });
  it('keeps File Explorer read-only and limited to file retrieval', async () => {
    const explorer = await readFile(packagePath('templates', 'agents', 'file-explorer.md'), 'utf8');

    expect(explorer).toMatch(/^tools: \[read, search\]$/m);
    expect(explorer).not.toMatch(/^tools: .*\b(?:edit|shell)\b.*$/m);
    expect(explorer).toMatch(/may only read files and search authorized paths/i);
    expect(explorer).toMatch(/may not edit or create any file/i);
    expect(explorer).not.toMatch(/context refresh|maintenance mode|MEMORY\.md.*update|write.*candidate/i);
  });
  it('gives Researcher bounded topic research and a research report contract', async () => {
    const researcher = await readFile(packagePath('templates', 'agents', 'researcher.md'), 'utf8');

    expect(researcher).toMatch(/^tools: \[read, web\]$/m);
    expect(researcher).toMatch(/technology.*project.*keyword/is);
    expect(researcher).toMatch(/links?.*(?:optional|if available)|(?:optional|if available).*links?/is);
    expect(researcher).toMatch(/delegate every request|must delegate/i);
    expect(researcher).toMatch(/research report/i);
    expect(researcher).toMatch(/sources|evidence|unresolved/i);
    expect(researcher).toMatch(/may not edit or create any file/i);
  });
  it('gives Documentation Maintainer bounded documentation and index ownership', async () => {
    const maintainer = await readFile(packagePath('templates', 'agents', 'documentation-maintainer.md'), 'utf8');

    expect(maintainer).toMatch(/^tools: \[read, edit\]$/m);
    expect(maintainer).toMatch(/MEMORY\.md|navigation\.json|navigation\.md/i);
    expect(maintainer).toMatch(/non-?code|non-?coding|documentation/i);
    expect(maintainer).toMatch(/May read and edit|may update/i);
    expect(maintainer).toMatch(/may not edit.*(?:source|tests|schema|plan)/is);
    expect(maintainer).toMatch(/may not run Git/i);
    expect(maintainer).toMatch(/primary orchestrator\s+directly\s+dispatches\s+Git\s+Operator/i);
    expect(maintainer).toMatch(/exact changed paths.*validation evidence/is);
  });
  it('describes optional risk-based coding review', async () => {
    const coding = await readFile(packagePath('templates', 'skills', 'coding', 'SKILL.md'), 'utf8');
    expect(coding).toMatch(/review.*risk|risk.*review/is);
    expect(coding).toMatch(/present the findings to the user.*selected repairs|repairing all findings/is);
    expect(coding).toMatch(/Do not merge\s+the\s+temporary\s+branch\s+or\s+worktree\s+until\s+the\s+user's\s+repair\s+choice\s+is\s+resolved/i);
    expect(coding).toMatch(/does not trigger a second Spec Review or Standards Review/is);
  });
  it('documents --project as a project root path with relative and absolute examples', async () => {
    const readme = await readFile(packagePath('README.md'), 'utf8');
    expect(readme).toContain('`--project .` (project root directory path)');
    expect(readme).toContain('`--project /path/to/project`');
    expect(readme).toContain('exact ID then exact alias');
    expect(readme).toContain('qualified `file#symbol` name');

    for (const path of ['templates/skills/planning/SKILL.md', 'templates/skills/plan-to-tasks/SKILL.md', 'templates/agents/file-explorer.md']) {
      const template = await readFile(packagePath(path), 'utf8');
      expect(template).toMatch(/--project <absolute-project-root>/i);
      expect(template).not.toMatch(/--project <project>/i);
    }
  });
  it('keeps planning and plan-to-tasks from committing their gitignored artifacts', async () => {
    for (const name of ['planning', 'plan-to-tasks']) {
      const text = await readFile(packagePath('templates', 'skills', name, 'SKILL.md'), 'utf8');
      // Planning and task artifacts live under the gitignored .ai-workflow directory.
      expect(text).toMatch(/gitignored/i);
      // The specialist neither stages nor commits its own artifacts.
      expect(text).toMatch(/do not stage or commit/i);
      // REQ-002: no automatic commit or Git Operator dispatch from these roles.
      expect(text).not.toMatch(/automatic local commit/i);
      expect(text).not.toMatch(/directly\s+dispatch(?:es|ed)?\s+Git\s+Operator/i);
      expect(text).not.toMatch(/Git Operator must use `\$git-message`/);
      // REQ-002: the specialist never dispatches Task Worker (no nested child dispatch).
      expect(text).not.toMatch(/delegate\s+(?:to\s+)?(?:the\s+)?`?task[- ]worker`?|dispatch\s+(?:to\s+)?(?:the\s+)?`?task[- ]worker`?/i);
    }
  });
  it('has Documentation Maintainer return commit evidence while the primary orchestrator directly dispatches Git Operator', async () => {
    const maintainer = await readFile(packagePath('templates', 'agents', 'documentation-maintainer.md'), 'utf8');
    // AC-003 / REQ-002: actor identity — the primary orchestrator, not the specialist, directly dispatches Git Operator.
    expect(maintainer).toMatch(/primary orchestrator\s+directly\s+dispatches\s+Git\s+Operator/i);
    // AC-003: the specialist returns exact changed paths/evidence to the primary orchestrator.
    expect(maintainer).toMatch(/exact changed paths.*(?:evidence|primary orchestrator)|provide.*(?:exact|completed).*(?:paths|evidence).*primary orchestrator/is);
    // REQ-002: the specialist never dispatches Git Operator or Task Worker (no nested dispatch).
    expect(maintainer).not.toMatch(/delegate Git Operator|dispatch Git Operator|delegate\s+(?:to\s+)?(?:the\s+)?`?task[- ]worker`?|dispatch\s+(?:to\s+)?(?:the\s+)?`?task[- ]worker`?/i);
    // REQ-003: the specialist never runs Git.
    expect(maintainer).toMatch(/may not run Git/i);
  });
  it('adds the project contract to the task template fixed context', async () => {
    const taskTemplate = await readFile(packagePath('templates', 'skills', 'plan-to-tasks', 'references', 'task.md'), 'utf8');
    const readScopes = [...taskTemplate.matchAll(/^read_scope:\s*(\[.*\])$/gm)].map((match) => match[1]);
    expect(readScopes.length).toBeGreaterThanOrEqual(2);
    for (const scope of readScopes) {
      for (const fixed of ['MEMORY.md', '.ai-workflow/index/navigation.json', '.ai-workflow/index/navigation.md', '.ai-workflow/AGENTS.md']) {
        expect(scope, `task template read_scope includes ${fixed}`).toContain(fixed);
      }
    }
  });
  it('routes planning and plan-to-tasks note work through the notes governance single source', async () => {
    for (const skill of ['planning', 'plan-to-tasks']) {
      const text = await readFile(packagePath('templates', 'skills', skill, 'SKILL.md'), 'utf8');
      expect(text, `${skill} loads the project contract`).toContain('.ai-workflow/AGENTS.md');
      expect(text, `${skill} points at the notes README`).toContain('.ai-workflow/notes/README.md');
      expect(text, `${skill} retires the ADR current mechanism`).not.toMatch(/\bADRs?\b|ai-workflow\s+adr\b|\.ai-workflow\/adr\b/i);
    }
  });
  // REQ-001 / AC-001 (production half): planning must require the bilingual triplet
  // before recording and validating the pair.
  it('requires planning to write both language sides, the English digest, the pair record, then validation', async () => {
    const text = await readFile(packagePath('templates', 'skills', 'planning', 'SKILL.md'), 'utf8');
    expect(text, 'planning names the Chinese side').toMatch(/\.zh\.md/);
    expect(text, 'planning names the consistency record').toMatch(/\.i18n\.yaml/);
    expect(text, 'planning records the pair with plan pairing --write').toMatch(/ai-workflow plan pairing --plan[^\n]*--write/);
    expect(text, 'planning validates with plan validate --plan').toMatch(/ai-workflow plan validate --plan/);
    expect(text, 'planning orders both sides, digest, pairing --write, then validation').toMatch(
      /\.zh\.md[\s\S]{0,4000}?digest[\s\S]{0,4000}?plan pairing[\s\S]{0,2000}?plan validate/i
    );
  });
  // REQ-001: the numbered planning workflow itself must carry the triplet and the
  // validation gate, so an agent following the steps cannot stop at spec.md/plan.md.
  it('makes the bilingual triplet and the plan validate gate ordered planning workflow steps', async () => {
    const text = await readFile(packagePath('templates', 'skills', 'planning', 'SKILL.md'), 'utf8');
    const workflow = text.match(/## Draft and review workflow[\s\S]*?(?=\n## |$)/)?.[0] ?? '';

    expect(workflow, 'the workflow section exists').not.toBe('');
    for (const file of ['spec.zh.md', 'plan.zh.md', 'spec.i18n.yaml', 'plan.i18n.yaml']) {
      expect(workflow, `the workflow names ${file}`).toContain(file);
    }
    expect(workflow, 'the workflow records the pair').toMatch(/ai-workflow plan pairing --plan[^\n]*--write spec plan/);
    expect(workflow, 'the workflow validates the triplet').toMatch(/ai-workflow plan validate --plan/);
    expect(workflow, 'the workflow makes validation a hard gate').toMatch(/hard completion gate/i);
    expect(workflow, 'the workflow forbids freezing an incomplete triplet').toMatch(/incomplete triplet/i);
  });
  // REQ-002 / AC-005 (production half): plan-to-tasks must require the task triplet
  // before recording and validating the pair.
  it('requires plan-to-tasks to write both language sides, record the pair, then validate', async () => {
    const text = await readFile(packagePath('templates', 'skills', 'plan-to-tasks', 'SKILL.md'), 'utf8');
    expect(text, 'plan-to-tasks names the Chinese side').toMatch(/\.zh\.md/);
    expect(text, 'plan-to-tasks names the consistency record').toMatch(/\.i18n\.yaml/);
    expect(text, 'plan-to-tasks records the pair with plan pairing --write').toMatch(/ai-workflow plan pairing --plan[^\n]*--write/);
    expect(text, 'plan-to-tasks orders both sides, pairing --write, then validation').toMatch(
      /\.zh\.md[\s\S]{0,4000}?plan pairing[\s\S]{0,2000}?plan validate/i
    );
  });
  // REQ-001 / REQ-002: the reference examples must show the exact switchers, the
  // blank English digest and the no-frontmatter Chinese side.
  it('shows the exact bilingual switchers and the no-frontmatter Chinese side in spec, plan and task references', async () => {
    const references = [
      ['planning', 'spec.md', 'Specification'],
      ['planning', 'plan.md', 'Implementation Plan'],
      ['plan-to-tasks', 'task.md', 'Task']
    ] as const;
    for (const [skill, file, title] of references) {
      const text = await readFile(packagePath('templates', 'skills', skill, 'references', file), 'utf8');
      expect(text, `${file} shows the English-side switcher`).toMatch(/English \| \[中文\]\([^)\n]+\.zh\.md\)/);
      expect(text, `${file} shows the Chinese-side switcher`).toMatch(/\[English\]\([^)\n]+\.md\) \| 中文/);
      expect(text, `${file} places a switcher immediately after the ${title} title with a blank line`).toMatch(
        new RegExp(`# ${title}\\n\\n(?:English \\| \\[中文\\]\\([^)\\n]+\\.zh\\.md\\)|\\[English\\]\\([^)\\n]+\\.md\\) \\| 中文)\\n\\n`)
      );
      expect(text, `${file} states that the Chinese side has no frontmatter`).toMatch(/\b(?:no|without|lacks)\b[^.\n]{0,60}frontmatter/i);
    }
    for (const file of ['spec.md', 'plan.md'] as const) {
      const text = await readFile(packagePath('templates', 'skills', 'planning', 'references', file), 'utf8');
      expect(text, `${file} keeps the blank English digest in frontmatter`).toContain('digest: ""');
    }
  });
  // REQ-006 / AC-013: the digest protocol is a shared entry point that records the
  // pair before validation.
  it('adds the pair-recording step to the frozen-plan digest protocol', async () => {
    const digest = await readFile(packagePath('templates', 'skills', 'planning', 'references', 'digest.md'), 'utf8');
    expect(digest, 'the digest protocol keeps the blank digest').toContain('digest: ""');
    expect(digest, 'the digest protocol hashes UTF-8 bytes').toMatch(/UTF-8/);
    expect(digest, 'the digest protocol uses SHA-256').toMatch(/sha-?256/i);
    expect(digest, 'the digest protocol records the pair').toMatch(/ai-workflow plan pairing --plan[^\n]*--write/);
    expect(digest, 'the digest protocol records the pair before validating').toMatch(/plan pairing[\s\S]{0,1500}?plan validate/i);
  });
  // REQ-006 / AC-013: both commands are shared verification entry points.
  it('presents plan validate and plan pairing as shared verification entry points', async () => {
    for (const skill of ['planning', 'plan-to-tasks']) {
      const text = await readFile(packagePath('templates', 'skills', skill, 'SKILL.md'), 'utf8');
      expect(text, `${skill} documents plan validate`).toMatch(/ai-workflow plan validate --plan/);
      expect(text, `${skill} documents plan pairing`).toMatch(/ai-workflow plan pairing --plan/);
    }
    const digest = await readFile(packagePath('templates', 'skills', 'planning', 'references', 'digest.md'), 'utf8');
    expect(digest, 'the shared digest protocol documents plan validate').toMatch(/ai-workflow plan validate --plan/);
    expect(digest, 'the shared digest protocol documents plan pairing').toMatch(/ai-workflow plan pairing --plan/);
  });
  // Review finding F1 (merge-blocking): shipped instructions must not prescribe the
  // `plan pairing --write` form the CLI rejects. Every `ai-workflow plan pairing`
  // occurrence must name `--plan <value>`, and a `--write` immediately followed by a
  // backtick, newline, end-of-string or `#` section comment is a violation because the
  // CLI rejects that bare form without `--all` or explicit document arguments.
  it('prescribes only CLI-accepted plan pairing command forms in shipped instructions', async () => {
    const sites = [
      'templates/skills/planning/SKILL.md',
      'templates/skills/planning/references/digest.md',
      'templates/skills/planning/references/spec.md',
      'templates/skills/planning/references/plan.md',
      'templates/skills/plan-to-tasks/SKILL.md',
      'templates/skills/plan-to-tasks/references/task.md',
      'src/install/render.ts',
      'README.md',
    ];
    const commandLiteral = 'ai-workflow plan pairing';
    const violations: string[] = [];
    for (const site of sites) {
      const contents = await readFile(packagePath(site), 'utf8');
      for (const match of contents.matchAll(/ai-workflow plan pairing/g)) {
        const start = match.index ?? 0;
        const rest = contents.slice(start);
        const terminator = rest.slice(commandLiteral.length).search(/[`\n]/);
        const command = terminator === -1 ? rest : rest.slice(0, commandLiteral.length + terminator);
        if (!/--plan\s+\S+/.test(command)) {
          violations.push(`${site}: "${command}" must name --plan with a value`);
          continue;
        }
        const writeIndex = command.indexOf('--write');
        if (writeIndex === -1) continue;
        const argument = command.slice(writeIndex + '--write'.length).replace(/^[ \t]+/, '');
        if (argument === '' || /^[`#\r\n]/.test(argument)) {
          violations.push(`${site}: "${command}" uses --write without --all or an explicit document argument`);
        }
      }
    }
    expect(violations, 'shipped plan pairing instructions must match the CLI contract').toEqual([]);
  });
});
