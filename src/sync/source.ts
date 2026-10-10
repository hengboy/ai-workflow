import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { generatedArtifacts, generatedDocumentError } from './artifacts.js';

const repository = 'hengboy/ai-workflow';
const branch = 'main';
const sourceUrl = 'https://github.com/hengboy/ai-workflow.git';
const projectDirectory = 'templates/project';

export type GitRunner = (arguments_: string[]) => Promise<{ stdout: string }>;

const execFileAsync = promisify(execFile);

const defaultGitRunner: GitRunner = async (arguments_) => {
  const { stdout } = await execFileAsync('git', arguments_, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { stdout };
};

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Acquire exactly the five generated sources at one immutable public commit. A shallow clone of
 * the fixed public address is pinned by a 40-hex commit; every required member must be present and
 * be markerless Markdown with a level-one title. Extras are ignored, and a missing or malformed
 * member rejects so no target can be written from an incomplete snapshot.
 */
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
    try {
      if (!(await stat(join(directory, projectDirectory))).isDirectory()) {
        throw new Error(`Template source directory is unavailable: ${projectDirectory}`);
      }
    } catch (error) {
      if (isMissing(error)) throw new Error(`Template source directory is unavailable: ${projectDirectory}`);
      throw error;
    }
    const files: Record<string, string> = {};
    for (const artifact of generatedArtifacts) {
      const path = artifact.source;
      let text: string;
      try {
        if (!(await stat(join(directory, path))).isFile()) throw new Error(`Template source file is unavailable: ${path}`);
        text = await readFile(join(directory, path), 'utf8');
      } catch (error) {
        if (isMissing(error)) throw new Error(`Template source is incomplete; a required generated member is missing: ${path}`);
        throw error;
      }
      const formatError = generatedDocumentError(text);
      if (formatError !== undefined) throw new Error(`Template source structure is invalid: ${path} (${formatError})`);
      files[path] = text;
    }
    return { source: { repository, branch, commit }, files };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
