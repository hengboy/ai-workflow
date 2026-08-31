import { describe, expect, it } from 'vitest';
import { git, gitBaseline } from '../../src/git/operator.js';
import { temporary } from '../helpers.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
describe('Git Operator helpers', () => {
  it('recognizes an unborn HEAD baseline', async () => { const root = await temporary(); await exec('git', ['init', '-b', 'main'], { cwd: root }); const baseline = await gitBaseline(root); expect(baseline.head).toBeNull(); expect(baseline.branch).toBe('main'); });
  it('denies remote and destructive operations', async () => { const root = await temporary(); await expect(git(root, ['push'])).rejects.toThrow(/forbidden/); await expect(git(root, ['reset', '--hard'])).rejects.toThrow(/forbidden/); });
});
