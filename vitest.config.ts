import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/behavior/**/*.test.ts', 'tests/install/**/*.test.ts', 'tests/unit/profile.test.ts', 'tests/integration/profile-cli.test.ts', 'tests/integration/navigation-*.test.ts', 'tests/integration/project-cli.test.ts', 'tests/integration/global-agent-guidance.test.ts'], environment: 'node', testTimeout: 20_000, hookTimeout: 20_000, coverage: { reporter: ['text'] } }
});
