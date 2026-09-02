import { describe, expect, it } from 'vitest';
import { objectDigest, stableJson } from '../../src/utils/hash.js';
import { parseMarkdown, renderMarkdown } from '../../src/utils/frontmatter.js';
import { frozenDocumentDigest, renderFrozenMarkdown } from '../../src/workflow/digest.js';
import { assertTransition } from '../../src/runtime/state.js';
import { redact, validateChangedPaths, validateRoleCommand } from '../../src/security/policy.js';

describe('core utilities', () => {
  it('creates stable digests regardless of property order', () => expect(objectDigest({ b: 2, a: 1 })).toBe(objectDigest({ a: 1, b: 2 })));
  it('round trips YAML frontmatter', () => { const value = parseMarkdown(renderMarkdown({ id: 'task-001' }, '# Body')); expect(value.attributes.id).toBe('task-001'); expect(value.body).toContain('# Body'); });
  it('generates a digest that verifies after it is embedded', () => { const source = renderFrozenMarkdown({ plan_id: '20260901-example', status: 'frozen' }, '# Spec'); expect(parseMarkdown(source).attributes.digest).toBe(frozenDocumentDigest(source)); });
  it('changes the digest when non-digest document bytes change', () => { const source = renderFrozenMarkdown({ plan_id: '20260901-example', status: 'frozen' }, '# Spec'); expect(frozenDocumentDigest(source.replace('# Spec', '# Changed'))).not.toBe(parseMarkdown(source).attributes.digest); });
  it('enforces state transitions', () => { expect(() => assertTransition('executing', 'validating')).not.toThrow(); expect(() => assertTransition('complete', 'executing')).toThrow(); });
  it('enforces roles, scopes and screenshot directory', () => { expect(validateRoleCommand('backend', 'git commit -m x')).toMatch(/Git Operator/); expect(validateRoleCommand('backend', 'rg foo')).toMatch(/File Explorer/); const node = { write_scope: ['src'] } as never; expect(validateChangedPaths(node, ['other/x.ts'], '.ai-workflow/plans/x/screenshot')).toHaveLength(1); });
  it('rejects every reported File Explorer file modification', () => { const node = { role: 'file-explorer', write_scope: [] } as never; expect(validateChangedPaths(node, ['MEMORY.md'], '.ai-workflow/plans/x/screenshot')).toEqual(['File Explorer cannot modify files']); });
  it('rejects File Explorer commands that can modify files', () => { expect(validateRoleCommand('file-explorer', 'touch result.txt')).toMatch(/read-only|retrieval/i); expect(validateRoleCommand('file-explorer', 'rg pattern src')).toBeUndefined(); });
  it('redacts common secrets', () => expect(redact('authorization: Bearer secret-value ghp_abcdefghijklmnop')).not.toContain('abcdefghijklmnop'));
  it('serializes JSON canonically', () => expect(stableJson({ z: [2, 1], a: true })).toBe('{"a":true,"z":[2,1]}'));
});
