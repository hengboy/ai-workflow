import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { validateOwnedSections } from './merge.js';

const repository = 'hengboy/ai-workflow';
const branch = 'main';
const sourceUrl = 'https://github.com/hengboy/ai-workflow.git';
const sourcePaths = [
  'templates/project/AGENTS.md',
  'templates/project/MEMORY.md',
  'templates/project/navigation.json',
  'templates/project/navigation.md',
  'templates/project/notes/AGENTS.md',
  'templates/project/notes/README.md',
  'templates/project/notes/implemented/AGENTS.md',
  'templates/project/notes/archived/AGENTS.md',
  'templates/project/notes/archived/manifest.json',
] as const;
const sourceDirectories = ['templates/project', 'templates/project/notes', 'templates/project/notes/implemented', 'templates/project/notes/archived'];

export type GitRunner = (arguments_: string[]) => Promise<{ stdout: string }>;

const execFileAsync = promisify(execFile);

const defaultGitRunner: GitRunner = async (arguments_) => {
  const { stdout } = await execFileAsync('git', arguments_, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { stdout };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export async function resolveTemplateSnapshot(options: { runGit?: GitRunner } = {}): Promise<{
  source: { repository: string; branch: string; commit: string };
  files: Record<string, string>;
}> {
  const git = options.runGit ?? defaultGitRunner;
  const directory = await mkdtemp(join(tmpdir(), 'ai-workflow-source-'));
  try {
    await git(['clone', '--depth', '1', '--branch', branch, sourceUrl, directory]);
    const commit = (await git(['-C', directory, 'rev-parse', 'HEAD'])).stdout.trim();
    if (!/^[0-9a-f]{40}$/i.test(commit)) {
      throw new Error(`Template source branch has no immutable commit: ${branch}`);
    }
    const projectDirectory = 'templates/project';
    try {
      if (!(await stat(join(directory, projectDirectory))).isDirectory()) {
        throw new Error(`Template source directory is unavailable: ${projectDirectory}`);
      }
    } catch (error) {
      if (isMissing(error)) throw new Error(`Template source directory is unavailable: ${projectDirectory}`);
      throw error;
    }
    for (const path of sourceDirectories) {
      try {
        if (!(await stat(join(directory, path))).isDirectory()) {
          throw new Error(`Template source directory is unavailable: ${path}`);
        }
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
    }
    const files: Record<string, string> = {};
    for (const path of sourcePaths) {
      let text: string;
      try {
        if (!(await stat(join(directory, path))).isFile()) {
          throw new Error(`Template source file is unavailable: ${path}`);
        }
        text = await readFile(join(directory, path), 'utf8');
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      try {
        if (path.endsWith('.md') && path !== 'templates/project/navigation.md') {
          validateOwnedSections(text, true);
        } else if (path.endsWith('.json')) {
          const data: unknown = JSON.parse(text);
          if (!isRecord(data)) throw new Error('Template data must be a JSON object');
          if (path === 'templates/project/notes/archived/manifest.json' && (data.version !== 1 || !isRecord(data.files))) {
            throw new Error('Archive manifest must contain version 1 and a files object');
          }
        }
      } catch (error) {
        throw new Error(`Template source structure is invalid: ${path} (${error instanceof Error ? error.message : String(error)})`);
      }
      files[path] = text;
    }
    return { source: { repository, branch, commit }, files };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
