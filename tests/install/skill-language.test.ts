import { describe, expect, it } from 'vitest';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { activateProfile, install } from '../../src/install/index.js';
import { renderHost } from '../../src/install/render.js';
import { exists } from '../../src/utils/fs.js';
import { packagePath } from '../../src/utils/schema.js';
import { temporary } from '../helpers.js';
import type { Host } from '../../src/workflow/types.js';

const hosts: Host[] = ['codex', 'claude', 'opencode'];
const configRelative = '.config/ai-workflow/config.yaml';
const manifestRelative = '.config/ai-workflow/install-manifest.json';
const skillsRelative = '.agents/skills';
const enMarker = 'Output language: English';
const zhMarker = 'Output language: Simplified Chinese (zh-CN)';
const directiveHeading = '## Output language';
const languageSkills = new Set(['planning/SKILL.md', 'plan-to-tasks/SKILL.md', 'coding/SKILL.md']);
const languageAgents = new Set(['documentation-maintainer']);
// REQ-008 / AC-016: the injected language section must describe notes structural
// requirements instead of the retired ADR-only fields, and keep a single prose
// language without sidecars or added configuration.
const notesStructuralClauses = ['field names', 'headings'];
const retiredAdrClauses = ['Architecture Decision Record', 'Supersedes', 'NNNN-kebab-title.md', 'superseded-by ADR-NNNN'];

function agentsRelative(host: Host): string {
  if (host === 'codex') return '.codex/agents';
  if (host === 'claude') return '.claude/agents';
  return '.config/opencode/agents';
}

async function seedConfig(home: string, contents: string): Promise<void> {
  await mkdir(join(home, '.config/ai-workflow'), { recursive: true });
  await writeFile(join(home, configRelative), contents);
}

async function filesUnder(root: string): Promise<string[]> {
  if (!(await exists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else files.push(path);
  }
  return files;
}

async function languageSkillContents(home: string, skill: string): Promise<string> {
  return readFile(join(home, skillsRelative, skill), 'utf8');
}

function installedDirective(contents: string): string {
  const index = contents.indexOf(directiveHeading);
  return index === -1 ? '' : contents.slice(index);
}

// Assert the injected section states notes structural requirements as English
// while keeping exactly one directive section (no duplicated language pair).
function expectNotesLanguageDirective(contents: string, label: string): string {
  const directive = installedDirective(contents);
  expect(directive, `${label} appends the output language directive`).not.toBe('');
  expect(directive.split(directiveHeading).length - 1, `${label} appends exactly one directive section`).toBe(1);
  expect(directive, `${label} names notes as the current decision record`).toMatch(/notes/i);
  expect(directive, `${label} keeps notes status values English`).toMatch(/status/i);
  for (const clause of notesStructuralClauses) {
    expect(directive, `${label} keeps ${clause} English`).toContain(clause);
  }
  return directive;
}

// Assert the retired ADR-only language fields are gone; notes are described as
// complete bilingual triplets rather than single-language or translated pairs.
function expectRetiredAdrFieldsDropped(contents: string, label: string): string {
  const directive = installedDirective(contents);
  expect(directive, `${label} appends the output language directive`).not.toBe('');
  for (const clause of retiredAdrClauses) {
    expect(directive, `${label} drops the retired ADR clause ${clause}`).not.toContain(clause);
  }
  expect(directive, `${label} drops the retired adr command`).not.toMatch(/ai-workflow\s+adr\b/i);
  expect(directive, `${label} drops the retired adr path`).not.toMatch(/\.ai-workflow\/adr\b/);
  expect(directive, `${label} does not request sidecars or translated pairs`).not.toMatch(/sidecar|translation pair/i);
  expect(directive, `${label} describes the note triplet`).toMatch(/\.zh\.md/);
  expect(directive, `${label} describes the consistency record`).toMatch(/\.i18n\.yaml/);
  return directive;
}

// Snapshot of every managed file plus the install manifest, excluding the user-owned configuration.
async function managedTree(home: string): Promise<Map<string, string>> {
  const paths = await filesUnder(join(home, skillsRelative));
  for (const host of hosts) paths.push(...await filesUnder(join(home, agentsRelative(host))));
  const manifest = join(home, manifestRelative);
  if (await exists(manifest)) paths.push(manifest);
  const tree = new Map<string, string>();
  for (const path of paths) tree.set(relative(home, path), await readFile(path, 'utf8'));
  return tree;
}

describe('installed skill output language', () => {
  it('installs the English directive when no configuration file exists', async () => {
    const home = await temporary('ai-workflow-language-default-');
    await install(hosts, { home });

    for (const skill of languageSkills) {
      const contents = await languageSkillContents(home, skill);
      expect(contents, `${skill} defaults to English`).toContain(enMarker);
      expect(contents).not.toContain(zhMarker);
      const directive = expectNotesLanguageDirective(contents, skill);
      expect(directive).toContain(enMarker);
      expect(directive).not.toContain(zhMarker);
    }

    for (const host of hosts) {
      const contents = await readFile(join(home, agentsRelative(host), `documentation-maintainer${host === 'codex' ? '.toml' : '.md'}`), 'utf8');
      expect(contents, `${host} documentation-maintainer defaults to English`).toContain(directiveHeading);
      expect(contents, `${host} documentation-maintainer defaults to English`).toContain(enMarker);
      expect(contents).not.toContain(zhMarker);
      const directive = expectNotesLanguageDirective(contents, `${host} documentation-maintainer`);
      expect(directive).toContain(enMarker);
      expect(directive).not.toContain(zhMarker);
      expect(contents, `${host} documentation-maintainer reads the notes governance source`).toContain('.ai-workflow/notes/README.md');
      for (const clause of retiredAdrClauses) {
        expect(contents, `${host} documentation-maintainer drops ${clause}`).not.toContain(clause);
      }
    }
  });

  it('installs the Simplified Chinese directive when output_language is zh-CN', async () => {
    const home = await temporary('ai-workflow-language-zh-');
    await seedConfig(home, 'output_language: zh-CN\n');
    await install(hosts, { home });

    for (const skill of languageSkills) {
      const contents = await languageSkillContents(home, skill);
      expect(contents, `${skill} uses Simplified Chinese`).toContain(zhMarker);
      expect(contents).not.toContain(enMarker);
      const directive = expectNotesLanguageDirective(contents, skill);
      expect(directive).toContain(zhMarker);
      // The notes structural requirements stay English under zh-CN.
      for (const clause of notesStructuralClauses) {
        expect(directive, `${skill} keeps ${clause} English`).toContain(clause);
      }
      expect(directive, `${skill} keeps the notes status marker English`).toMatch(/status/i);
    }

    for (const host of hosts) {
      const contents = await readFile(join(home, agentsRelative(host), `documentation-maintainer${host === 'codex' ? '.toml' : '.md'}`), 'utf8');
      expect(contents, `${host} documentation-maintainer uses Simplified Chinese`).toContain(directiveHeading);
      expect(contents, `${host} documentation-maintainer uses Simplified Chinese`).toContain(zhMarker);
      expect(contents).not.toContain(enMarker);
      const directive = expectNotesLanguageDirective(contents, `${host} documentation-maintainer`);
      expect(directive).toContain(zhMarker);
      expect(directive).not.toContain(enMarker);
    }
  });

  it('injects the directive only into the three language skills and Documentation Maintainer', async () => {
    const home = await temporary('ai-workflow-language-scope-');
    await seedConfig(home, 'output_language: zh-CN\n');
    await install(hosts, { home });

    const templateRoot = packagePath('templates', 'skills');
    for (const templatePath of await filesUnder(templateRoot)) {
      const relativePath = relative(templateRoot, templatePath);
      const installed = await readFile(join(home, skillsRelative, relativePath), 'utf8');
      const template = await readFile(templatePath, 'utf8');
      if (languageSkills.has(relativePath)) {
        expect(installed, `${relativePath} receives the directive`).not.toBe(template);
        expect(installed.startsWith(template), `${relativePath} preserves its template`).toBe(true);
        expect(installed, `${relativePath} names the language`).toContain(zhMarker);
        const directive = expectNotesLanguageDirective(installed, relativePath);
        expect(directive).toContain(zhMarker);
        expect(directive).not.toContain(enMarker);
      } else {
        expect(installed, `${relativePath} matches its template`).toBe(template);
        expect(installed, `${relativePath} has no directive`).not.toContain(directiveHeading);
      }
    }

    for (const host of hosts) {
      const baseline = await renderHost(host);
      for (const file of baseline) {
        const installed = await readFile(join(home, agentsRelative(host), file.relativePath), 'utf8');
        const agentName = file.relativePath.replace(/\.(?:toml|md)$/, '');
        if (languageAgents.has(agentName)) {
          expect(installed, `${host}/${file.relativePath} receives the directive`).not.toBe(file.contents);
          expect(installed.startsWith(file.contents), `${host}/${file.relativePath} preserves its rendering`).toBe(true);
          expect(installed, `${host}/${file.relativePath} names the language`).toContain(zhMarker);
          const directive = expectNotesLanguageDirective(installed, `${host}/${file.relativePath}`);
          expect(directive).toContain(zhMarker);
          expect(directive).not.toContain(enMarker);
          for (const clause of retiredAdrClauses) {
            expect(installed, `${host}/${file.relativePath} drops ${clause}`).not.toContain(clause);
          }
        } else {
          expect(installed, `${host}/${file.relativePath} matches the unchanged rendering`).toBe(file.contents);
          expect(installed, `${host}/${file.relativePath} has no directive`).not.toContain(directiveHeading);
        }
      }
    }
  });

  it('states the language and the prose-only rule in the appended section', async () => {
    const home = await temporary('ai-workflow-language-directive-');
    await seedConfig(home, 'output_language: zh-CN\n');
    await install(hosts, { home });

    const clauses = ['headings', 'table headers', 'frontmatter', 'REQ-###', 'AC-###', 'file paths', 'code', 'surface'];
    const sessionClauses = ['clarification questions', 'confirmation previews', 'progress narration', 'final summary'];
    for (const skill of languageSkills) {
      const contents = await languageSkillContents(home, skill);
      expect(contents).toContain(directiveHeading);
      expect(contents).toContain(zhMarker);
      expect(contents).toContain('Simplified Chinese');
      for (const clause of clauses) {
        expect(contents, `${skill} mentions ${clause}`).toContain(clause);
      }
      for (const clause of sessionClauses) {
        expect(contents, `${skill} mentions ${clause}`).toContain(clause);
      }
      expect(contents).toMatch(/remain English/);
    }
  });

  it('replaces the directive when the configuration changes and install runs again', async () => {
    const home = await temporary('ai-workflow-language-reinstall-');
    await seedConfig(home, 'output_language: en\n');
    await install(hosts, { home });
    await expect(languageSkillContents(home, 'planning/SKILL.md')).resolves.toContain(enMarker);

    await seedConfig(home, 'output_language: zh-CN\n');
    await install(hosts, { home });
    for (const skill of languageSkills) {
      const contents = await languageSkillContents(home, skill);
      expect(contents).toContain(zhMarker);
      expect(contents).not.toContain(enMarker);
    }
    for (const host of hosts) {
      const contents = await readFile(join(home, agentsRelative(host), `documentation-maintainer${host === 'codex' ? '.toml' : '.md'}`), 'utf8');
      expect(contents).toContain(zhMarker);
      expect(contents).not.toContain(enMarker);
    }

    await seedConfig(home, 'output_language: en\n');
    await install(hosts, { home });
    for (const skill of languageSkills) {
      const contents = await languageSkillContents(home, skill);
      expect(contents).toContain(enMarker);
      expect(contents).not.toContain(zhMarker);
    }
  });

  it('replaces the directive through activateProfile', async () => {
    const home = await temporary('ai-workflow-language-activate-');
    await seedConfig(home, 'output_language: en\n');
    await install(['codex'], { home });
    const profiles = join(home, '.config/ai-workflow/profiles');
    await mkdir(profiles, { recursive: true });
    await writeFile(join(profiles, 'team.yaml'), 'version: 1.0.0\nagents:\n  test:\n    codex: { model: gpt-5.6, reasoning_effort: medium }\n');

    await seedConfig(home, 'output_language: zh-CN\n');
    await activateProfile('team', { home });

    for (const skill of languageSkills) {
      const contents = await languageSkillContents(home, skill);
      expect(contents, `${skill} uses the new language after activateProfile`).toContain(zhMarker);
      expect(contents).not.toContain(enMarker);
    }
    for (const host of hosts) {
      const contents = await readFile(join(home, agentsRelative(host), `documentation-maintainer${host === 'codex' ? '.toml' : '.md'}`), 'utf8');
      expect(contents, `${host} documentation-maintainer uses the new language after activateProfile`).toContain(zhMarker);
      expect(contents).not.toContain(enMarker);
    }
  });

  it('drops retired ADR-only language fields and requests no translation artifacts', async () => {
    const home = await temporary('ai-workflow-language-adr-drop-');
    await seedConfig(home, 'output_language: zh-CN\n');
    await install(hosts, { home });

    for (const skill of languageSkills) {
      expectRetiredAdrFieldsDropped(await languageSkillContents(home, skill), skill);
    }
    for (const host of hosts) {
      const contents = await readFile(join(home, agentsRelative(host), `documentation-maintainer${host === 'codex' ? '.toml' : '.md'}`), 'utf8');
      expectRetiredAdrFieldsDropped(contents, `${host} documentation-maintainer`);
      expect(contents, `${host} documentation-maintainer has no retired ADR file naming`).not.toMatch(/NNNN-kebab-title|superseded-by ADR-NNNN/);
    }
  });

  it('injects the notes structural requirements in both en and zh-CN', async () => {
    for (const { language, marker, other } of [
      { language: 'en', marker: enMarker, other: zhMarker },
      { language: 'zh-CN', marker: zhMarker, other: enMarker }
    ]) {
      const home = await temporary(`ai-workflow-language-notes-${language}-`);
      await seedConfig(home, `output_language: ${language}\n`);
      await install(hosts, { home });

      for (const skill of languageSkills) {
        const directive = expectNotesLanguageDirective(await languageSkillContents(home, skill), skill);
        expect(directive).toContain(marker);
        expect(directive).not.toContain(other);
      }

      for (const host of hosts) {
        const contents = await readFile(join(home, agentsRelative(host), `documentation-maintainer${host === 'codex' ? '.toml' : '.md'}`), 'utf8');
        const directive = expectNotesLanguageDirective(contents, `${host} documentation-maintainer`);
        expect(directive).toContain(marker);
        expect(directive).not.toContain(other);
      }
    }
  });

  it('derives the notes language section from output_language alone without new configuration or sidecars', async () => {
    const home = await temporary('ai-workflow-language-notes-config-');
    await seedConfig(home, 'output_language: zh-CN\n');
    await install(hosts, { home });

    expect(await readFile(join(home, configRelative), 'utf8')).toBe('output_language: zh-CN\n');

    const schema = JSON.parse(await readFile(packagePath('schemas', 'settings.schema.json'), 'utf8')) as {
      additionalProperties?: boolean;
      properties?: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties ?? {}).filter((key) => /language/i.test(key)), 'no new language configuration item').toEqual(['output_language']);
    expect(schema.additionalProperties, 'unknown configuration keys are rejected').toBe(false);

    for (const path of (await managedTree(home)).keys()) {
      expect(path, `${path} is not a sidecar or translation pair`).not.toMatch(/sidecar|bilingual|translation|\.(?:en|zh-CN)\./i);
    }
  });

  it('preserves the user configuration and keeps it out of the install manifest', async () => {
    const home = await temporary('ai-workflow-language-invariants-');
    const configuration = 'output_language: zh-CN\n';
    await seedConfig(home, configuration);
    await install(hosts, { home });

    expect(await readFile(join(home, configRelative), 'utf8')).toBe(configuration);
    expect(await readFile(join(home, manifestRelative), 'utf8')).not.toContain('config.yaml');
  });

  for (const invalid of [
    { label: 'an unsupported output_language value', contents: 'output_language: fr\n' },
    { label: 'malformed YAML', contents: 'output_language: "unterminated\n' }
  ]) {
    it(`aborts ${invalid.label} on a fresh home without creating managed files`, async () => {
      const home = await temporary('ai-workflow-language-abort-fresh-');
      await seedConfig(home, invalid.contents);

      await expect(install(hosts, { home })).rejects.toThrow(/must be one of 'en' and 'zh-CN'/);

      expect((await managedTree(home)).size).toBe(0);
      expect(await readFile(join(home, configRelative), 'utf8')).toBe(invalid.contents);
    });

    it(`aborts ${invalid.label} after a prior install without changing the managed tree`, async () => {
      const home = await temporary('ai-workflow-language-abort-prior-');
      await install(hosts, { home });
      const before = await managedTree(home);
      expect(before.size).toBeGreaterThan(0);
      await seedConfig(home, invalid.contents);

      await expect(install(hosts, { home })).rejects.toThrow(/must be one of 'en' and 'zh-CN'/);

      const after = await managedTree(home);
      expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
      for (const [path, contents] of before) {
        expect(after.get(path), `${path} is byte-identical after the rejected install`).toBe(contents);
      }
    });
  }
});
