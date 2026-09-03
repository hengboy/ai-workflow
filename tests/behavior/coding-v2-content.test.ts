import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { packagePath } from '../../src/utils/schema.js';

describe('v2 coding guidance', () => {
  it('describes the v2 artifact and trusted execution boundary', async () => {
    const coding = await readFile(packagePath('templates', 'skills', 'coding', 'SKILL.md'), 'utf8');
    const project = await readFile(packagePath('templates', 'project', 'AGENTS.md'), 'utf8');
    const readme = await readFile(packagePath('README.md'), 'utf8');
    const text = `${coding}\n${project}\n${readme}`;

    for (const term of ['workflow.js', 'workflow.args.json', 'actionId', 'callId', 'itemKey', 'trusted', 'broker', 'executor', 'scope audit', 'Git mutex', 'repair-test', 'serial']) expect(text).toContain(term);
    expect(text).toContain('.ai-workflow/runs/<runId>/worktrees/plan');
    expect(text).toContain('.ai-workflow/runs/<runId>/worktrees/tasks/<taskId>');
    expect(text).toContain('.ai-workflow/runs/<runId>/worktrees/repair');
    expect(text).toContain('.ai-workflow/runs/<runId>/worktrees/repair-tests/<taskId>');
    expect(text).not.toMatch(/--adjustments-stdin|workflow\.candidate\.json|fixed six|固定六节点|<project>\/\.worktrees|VM.*安全沙箱/i);
  });
});
