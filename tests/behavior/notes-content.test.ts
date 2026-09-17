import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { packagePath } from '../../src/utils/schema.js';

// REQ-008 / AC-015: installed skills and roles must load the project contract and
// route note governance through the single-source README instead of restating or
// reviving the retired ADR mechanism. These assertions cover non-omittable entry
// points and constraints only; they do not prove semantic correctness.
const WORKFLOW_ARTIFACTS = [
  'templates/skills/planning/SKILL.md',
  'templates/skills/plan-to-tasks/SKILL.md',
  'templates/skills/coding/SKILL.md',
  'templates/agents/file-explorer.md',
  'templates/agents/documentation-maintainer.md',
  'templates/agents/spec-review.md',
  'templates/agents/standards-review.md',
  'templates/agents/git-operator.md',
];

const NOTES_GOVERNANCE_CONSUMERS = [
  'templates/skills/planning/SKILL.md',
  'templates/skills/plan-to-tasks/SKILL.md',
  'templates/skills/coding/SKILL.md',
  'templates/agents/documentation-maintainer.md',
  'templates/agents/standards-review.md',
];

const PROJECT_CONTRACT = '.ai-workflow/AGENTS.md';
const NOTES_README = '.ai-workflow/notes/README.md';

async function read(path: string): Promise<string> {
  return readFile(packagePath(path), 'utf8');
}

describe('agent notes workflow content', () => {
  it('loads the project contract from every shipped skill and workflow role', async () => {
    for (const path of WORKFLOW_ARTIFACTS) {
      const text = await read(path);
      expect(text, `${path} loads ${PROJECT_CONTRACT}`).toContain(PROJECT_CONTRACT);
    }
  });

  it('routes note format and governance through the single-source README', async () => {
    const governance = await read('templates/project/notes/README.md');
    expect(governance, 'README is the single source').toMatch(/single source/i);
    expect(governance, 'delivered records use Decision').toContain('Decision');
    expect(governance, 'delivered records use Consequences').toContain('Consequences');
    expect(governance, 'status-only transitions are rejected').toMatch(/only Status|Status[^.]{0,80}insufficient/i);
    expect(governance, 'supersession is governed').toMatch(/supersession/i);
    expect(governance, 'archiving is governed').toMatch(/archive policy/i);

    for (const path of NOTES_GOVERNANCE_CONSUMERS) {
      const text = await read(path);
      expect(text, `${path} points at ${NOTES_README}`).toContain(NOTES_README);
    }

    for (const path of ['templates/project/AGENTS.md', 'templates/project/MEMORY.md']) {
      const text = await read(path);
      expect(text, `${path} points at ${NOTES_README}`).toContain(NOTES_README);
    }
  });

  it('documents the bilingual note triplet in the governance source and its consumers', async () => {
    const governance = await read('templates/project/notes/README.md');
    expect(governance, 'the governance source describes the Chinese body').toContain('.zh.md');
    expect(governance, 'the governance source describes the consistency record').toContain('.i18n.yaml');
    expect(governance, 'the consistency record stores git blob hashes').toMatch(/git blob hash/i);
    expect(governance, 'language switchers are required').toMatch(/language switcher/i);
    expect(governance, 'the pairing command records pairs').toMatch(/notes pairing/);

    const maintainer = await read('templates/agents/documentation-maintainer.md');
    expect(maintainer, 'the maintainer maintains bilingual triplets').toMatch(/bilingual triplet/i);
    expect(maintainer, 'the maintainer records confirmed pairs').toMatch(/notes pairing/);
  });

  it('no longer treats ADR as the current decision mechanism in shipped skills, roles and contracts', async () => {
    const artifacts = [
      ...WORKFLOW_ARTIFACTS,
      'templates/project/AGENTS.md',
      'templates/project/MEMORY.md',
      'templates/project/notes/README.md',
    ];
    for (const path of artifacts) {
      const text = await read(path);
      expect(text, `${path} has no retired adr command`).not.toMatch(/ai-workflow\s+adr\b/i);
      expect(text, `${path} has no retired adr storage path`).not.toMatch(/\.ai-workflow\/adr\b/);
      expect(text, `${path} has no retired adr file naming`).not.toContain('NNNN-kebab-title.md');
      expect(text, `${path} has no retired adr status value`).not.toContain('superseded-by ADR-NNNN');
      expect(text, `${path} has no ADR rule text`).not.toMatch(/\bADRs?\b/);
    }
  });

  it('requires a landing change to maintain its note and run the mechanical validator', async () => {
    const coding = await read('templates/skills/coding/SKILL.md');
    expect(coding, 'coding runs the notes validator').toMatch(/notes validate/i);
    expect(coding, 'coding transitions proposed work to implemented').toMatch(/\bimplemented\b/i);

    const maintainer = await read('templates/agents/documentation-maintainer.md');
    expect(maintainer, 'maintainer owns supersession decisions').toMatch(/supersess/i);

    const standards = await read('templates/agents/standards-review.md');
    expect(standards, 'standards review checks MEMORY and its referenced notes rules').toMatch(/referenced notes|notes rules/i);
  });

  it('keeps worktree, ownership and read-only review boundaries intact', async () => {
    const coding = await read('templates/skills/coding/SKILL.md');
    expect(coding).toMatch(/project-local temporary worktree/i);
    expect(coding).toMatch(/Git Operator is the only role allowed to run Git|Git operations are allowed only through Git Operator/i);

    const maintainer = await read('templates/agents/documentation-maintainer.md');
    expect(maintainer).toMatch(/^tools: \[read, edit\]$/m);
    expect(maintainer).toMatch(/may not run Git/i);
    expect(maintainer).toMatch(/may not edit source/i);

    for (const path of ['templates/agents/spec-review.md', 'templates/agents/standards-review.md']) {
      expect(await read(path), `${path} stays read-only`).toMatch(/^tools: \[read\]$/m);
    }
  });
});
