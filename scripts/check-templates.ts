import { checkTemplateFragments, formatTemplateFragmentCheck, writeTemplateFragments } from '../src/ops/template-fragments.js';

try {
  const values = process.argv.slice(2).filter((argument) => argument !== '--');
  let write = false;
  for (const value of values) {
    if (value === '--write') {
      write = true;
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  const result = write ? await writeTemplateFragments(process.cwd()) : await checkTemplateFragments(process.cwd());
  process.stdout.write(`${formatTemplateFragmentCheck(result)}\n`);
  if (!result.valid) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
