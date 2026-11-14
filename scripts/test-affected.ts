import { formatAffectedTests, suggestAffectedTests } from '../src/ops/test-affected.js';

const paths = process.argv.slice(2).filter((argument) => argument !== '--');
const result = await suggestAffectedTests(process.cwd(), paths);
process.stdout.write(`${formatAffectedTests(result)}\n`);
process.exitCode = result.exitCode;
