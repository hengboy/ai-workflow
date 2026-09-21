import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type OpencodeVersion = 'v1' | 'v2';
export type OpencodeVersionOption = OpencodeVersion | 'auto';

export function parseOpencodeMajor(output: string): number | undefined {
  const match = output.match(/(\d+)\.\d+\.\d+/);
  if (!match) return undefined;
  const major = Number(match[1]);
  return Number.isSafeInteger(major) ? major : undefined;
}

export async function detectOpencodeVersion(): Promise<OpencodeVersion | undefined> {
  try {
    const { stdout } = await execFileAsync('opencode', ['--version'], { timeout: 5000 });
    const major = parseOpencodeMajor(stdout);
    if (major === undefined) return undefined;
    return major >= 2 ? 'v2' : 'v1';
  } catch {
    return undefined;
  }
}

export async function resolveOpencodeVersion(explicit?: OpencodeVersionOption): Promise<OpencodeVersion> {
  if (explicit === 'v1' || explicit === 'v2') return explicit;
  if (explicit === 'auto') return (await detectOpencodeVersion()) ?? 'v2';
  return 'v2';
}
