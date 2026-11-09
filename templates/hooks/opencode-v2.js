import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const executable = '__AI_WORKFLOW_NODE__';
const cli = '__AI_WORKFLOW_CLI__';
const noticeLimit = 2000;

async function adoptedRoot(directory) {
  let root = resolve(directory);
  while (true) {
    try { await stat(join(root, '.ai-workflow')); return root; } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
    const parent = dirname(root);
    if (parent === root) return undefined;
    root = parent;
  }
}

function invokeHook(input) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, [cli, 'sync-hook', '--host', 'opencode'], { cwd: input.cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) { reject(new Error(`ai-workflow sync-hook failed (${code}): ${stderr}`)); return; }
      try {
        const result = JSON.parse(stdout);
        if (!['allow', 'deny', 'skip'].includes(result.decision) || typeof result.project !== 'string' || typeof result.context !== 'string') throw new Error('Invalid ai-workflow gate result');
        resolveResult(result);
      } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export default {
  id: 'ai-workflow.sync',
  async setup(ctx) {
    const results = new Map();
    const directories = new Map();
    const loadedAuthority = new Map();
    const starts = new Map();
    const controller = new AbortController();

    async function lookup(id) {
      const session = await ctx.session.get({ sessionID: id });
      if (!session || typeof session.directory !== 'string' || !session.directory) throw new Error(`Cannot resolve the actual OpenCode session directory: ${id}`);
      return session;
    }

    async function synchronize(sessionID, event, toolName, toolInput) {
      const session = await lookup(sessionID);
      const root = await adoptedRoot(session.directory);
      let owner = session;
      while (root && owner.parentID) {
        const parent = await lookup(owner.parentID);
        if (await adoptedRoot(parent.directory) !== root) break;
        owner = parent;
      }
      const shared = owner.id !== session.id;
      const hookEvent = shared ? 'PreToolUse' : event === 'UserPromptSubmit' ? event : starts.has(sessionID) || !results.has(sessionID) ? 'SessionStart' : event;
      const result = await invokeHook({
        cwd: session.directory,
        session_id: owner.id,
        hook_event_name: hookEvent,
        ...(hookEvent === 'SessionStart' ? { source: starts.get(sessionID) ?? 'resume' } : {}),
        ...(toolName === undefined ? {} : { tool_name: toolName, tool_input: toolInput }),
      });
      const previous = results.get(sessionID);
      directories.set(sessionID, session.directory);
      if (result.exemption !== undefined) return result;
      results.set(sessionID, result);
      starts.delete(sessionID);
      if (result.decision === 'deny' || (result.report?.warnings.length && previous?.context !== result.context)) {
        // The server plugin API has no TUI toast, so the notice stays a bounded diagnostic line.
        const notice = result.context.length > noticeLimit ? `${result.context.slice(0, noticeLimit)}...` : result.context;
        console.error(`ai-workflow synchronization: ${notice}`);
      }
      return result;
    }

    function rememberAuthority(sessionID, project, authority) {
      const roots = loadedAuthority.get(sessionID) ?? new Map();
      roots.set(project, authority);
      loadedAuthority.set(sessionID, roots);
    }

    function contractTarget(sessionID, args) {
      if (typeof args.filePath !== 'string') return undefined;
      const path = resolve(directories.get(sessionID), args.filePath);
      if (basename(path) !== 'AGENTS.md' || basename(dirname(path)) !== '.ai-workflow') return undefined;
      return { root: dirname(dirname(path)), path };
    }

    function readsAuthority(sessionID, tool, args, project) {
      return tool === 'read' && contractTarget(sessionID, args)?.path === join(project, '.ai-workflow/AGENTS.md');
    }

    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type === 'session.created') {
          starts.set(event.data.sessionID, 'startup');
          loadedAuthority.delete(event.data.sessionID);
        } else if (event.type === 'session.compaction.ended') {
          starts.set(event.data.sessionID, 'compact');
          loadedAuthority.delete(event.data.sessionID);
        } else if (event.type === 'session.deleted') {
          results.delete(event.data.sessionID);
          directories.delete(event.data.sessionID);
          loadedAuthority.delete(event.data.sessionID);
          starts.delete(event.data.sessionID);
        }
      }
    })();

    await ctx.session.hook('prompt', async (event) => {
      loadedAuthority.delete(event.sessionID);
      await synchronize(event.sessionID, 'UserPromptSubmit');
    });

    await ctx.session.hook('context', async (event) => {
      if (!event.sessionID) return;
      const result = await synchronize(event.sessionID, 'PreToolUse');
      event.system.push({ type: 'text', text: result.context });
      if (result.authority !== undefined) rememberAuthority(event.sessionID, result.project, result.authority);
    });

    await ctx.tool.hook('execute.before', async (event) => {
      const result = await synchronize(event.sessionID, 'PreToolUse', event.tool, event.input);
      if (result.decision === 'deny') throw new Error(result.context);
      const loaded = loadedAuthority.get(event.sessionID)?.get(result.project);
      if (result.authority !== undefined && loaded !== result.authority && !readsAuthority(event.sessionID, event.tool, event.input, result.project)) {
        throw new Error(`${result.context}\nRead ${join(result.project, '.ai-workflow/AGENTS.md')} before ordinary project work continues.`);
      }
    });

    await ctx.tool.hook('execute.after', async (event) => {
      if (event.tool !== 'read') return;
      const session = await lookup(event.sessionID);
      directories.set(event.sessionID, session.directory);
      const target = contractTarget(event.sessionID, event.input);
      if (target === undefined) return;
      const content = await readFile(target.path, 'utf8').catch(() => undefined);
      if (content !== undefined) rememberAuthority(event.sessionID, target.root, content);
    });

    return () => controller.abort();
  },
};
