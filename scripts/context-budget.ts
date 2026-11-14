import { computeContextBudget, type ContextBudgetReport } from '../src/ops/context-budget.js';

interface Options {
  json: boolean;
  baseline?: string;
}

function parse(arguments_: string[]): Options {
  const options: Options = { json: false };
  const values = arguments_.filter((argument) => argument !== '--');
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    if (argument === '--baseline') {
      const value = values[index + 1];
      if (value === undefined) throw new Error('--baseline requires a path');
      options.baseline = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument ?? ''}`);
  }
  return options;
}

function render(report: ContextBudgetReport): string {
  const lines: string[] = [];
  for (const group of report.groups) {
    const delta = group.delta === undefined ? '' : ` delta=${group.delta}`;
    lines.push(`${group.id}: ${group.code_points}${delta}`);
    for (const file of group.files) {
      const fileDelta = file.delta === undefined ? '' : ` delta=${file.delta}`;
      lines.push(`  ${file.path}: ${file.code_points}${fileDelta}`);
    }
  }
  return lines.join('\n');
}

try {
  const options = parse(process.argv.slice(2));
  const report = await computeContextBudget(process.cwd(), options.baseline === undefined ? {} : { baseline: options.baseline });
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${render(report)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
