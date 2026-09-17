import { describe, expect, it } from 'vitest';
import {
  blobHash,
  chineseSwitcher,
  englishSwitcher,
  noteStructureSignature,
  pairAnchorOfArgument,
  parsePairMeta,
  renderPairMeta,
  structureDiff,
} from '../../src/notes/pairing.js';

describe('bilingual note pairing primitives', () => {
  it('computes the git blob hash of file content', () => {
    expect(blobHash('a')).toBe('2e65efe2a145dda7ee51d1741299f848e5bf752e');
    expect(blobHash('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    expect(blobHash('')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  });

  it('normalizes any file of a pair or its bare stem to the English anchor', () => {
    expect(pairAnchorOfArgument('implemented/process/2026-09-17-example.md')).toBe('implemented/process/2026-09-17-example.md');
    expect(pairAnchorOfArgument('implemented/process/2026-09-17-example.zh.md')).toBe('implemented/process/2026-09-17-example.md');
    expect(pairAnchorOfArgument('implemented/process/2026-09-17-example.i18n.yaml')).toBe('implemented/process/2026-09-17-example.md');
    expect(pairAnchorOfArgument('./implemented\\process\\2026-09-17-example')).toBe('implemented/process/2026-09-17-example.md');
  });

  it('round-trips the consistency record and rejects malformed or duplicate entries', () => {
    const record = renderPairMeta('.ai-workflow/notes/implemented/process/2026-09-17-example.md', blobHash('en'), blobHash('zh'));

    expect(record).toContain('# Bilingual-pair consistency record');
    expect(record).toContain('ai-workflow notes pairing --project <project-root> --write .ai-workflow/notes/implemented/process/2026-09-17-example.md');
    expect(parsePairMeta(record)).toEqual(new Map([
      ['2026-09-17-example.md', blobHash('en')],
      ['2026-09-17-example.zh.md', blobHash('zh')],
    ]));

    expect(parsePairMeta('2026-09-17-example.md: not-a-hash\n')).toBeUndefined();
    expect(parsePairMeta('2026-09-17-example.md: 2e65efe2a145dda7ee51d1741299f848e5bf752e\n2026-09-17-example.md: 2e65efe2a145dda7ee51d1741299f848e5bf752e\n')).toBeUndefined();
    expect(parsePairMeta('<no colon>')).toBeUndefined();
  });

  it('renders the required language switchers', () => {
    expect(englishSwitcher('.ai-workflow/notes/proposed/feature/2026-09-17-example.md')).toBe('English | [中文](2026-09-17-example.zh.md)');
    expect(chineseSwitcher('.ai-workflow/notes/proposed/feature/2026-09-17-example.md')).toBe('[English](2026-09-17-example.md) | 中文');
  });

  const englishNote = `# Agent Note: example

Status: implemented

English | [中文](2026-09-17-example.zh.md)

## Problem

Prose.

\`\`\`ts
const value = 1;
\`\`\`

| Column | Other |
| --- | --- |
| a | b |
| c | d |

- first
- second

See [the other note](../../implemented/process/2026-09-17-other.md).
`;

  const chineseNote = `# Agent Note: 示例

Status: implemented

[English](2026-09-17-example.md) | 中文

## Problem

正文。

\`\`\`ts
const value = 1;
\`\`\`

| Column | Other |
| --- | --- |
| 甲 | 乙 |
| 丙 | 丁 |

- 第一
- 第二

See [the other note](../../implemented/process/2026-09-17-other.zh.md).
`;

  it('treats mirrored bilingual notes as structurally identical', () => {
    const english = noteStructureSignature(englishNote, '2026-09-17-example.zh.md');
    const chinese = noteStructureSignature(chineseNote, '2026-09-17-example.md');

    expect(english).toEqual({ headings: [1, 2], code: ['ts\nconst value = 1;'], tables: ['3x2'], lists: ['bullet:items=2'], links: ['../../implemented/process/2026-09-17-other.md'] });
    expect(structureDiff(english, chinese)).toEqual([]);
  });

  it('reports the first divergence for each structural field', () => {
    const base = noteStructureSignature(englishNote, '2026-09-17-example.zh.md');

    const cases: [string, string][] = [
      ['heading', englishNote.replace('## Problem', '###### Problem')],
      ['code', englishNote.replace('const value = 1;', 'const value = 1;\nconst other = 2;')],
      ['table', englishNote.replace('| c | d |', '| e | f |\n| g | h |')],
      ['list', englishNote.replace('- second', '- second\n- third')],
      ['link', englishNote.replace('2026-09-17-other.md', '2026-09-17-different.md')],
    ];
    for (const [field, mutated] of cases) {
      expect(mutated, `${field} mutation changes the source`).not.toBe(englishNote);
      expect(structureDiff(base, noteStructureSignature(mutated, '2026-09-17-example.zh.md')).length, `${field} divergence is reported`).toBeGreaterThan(0);
    }
  });
});
