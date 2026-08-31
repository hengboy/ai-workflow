# Feature navigation

| Feature | Entry | Responsibility |
| --- | --- | --- |
| CLI | `src/cli.ts` | Parse public commands and report errors |
| Install/init | `src/install/index.ts` | Render and atomically manage host/project files |
| Workflow | `src/workflow/generate.ts` | Generate validated DAGs from frozen plans/tasks |
| Runtime | `src/runtime/runner.ts` | State transitions, execution, resume/cancel/cleanup |
| Host process | `src/adapters/process.ts` | Non-interactive stdin/event/result protocol |
| Policy | `src/security/policy.ts` | Roles, scopes, commands, snapshots and screenshots |
| Git | `src/git/operator.ts` | Worktrees, commits and non-FF integration |
| Context | `src/context/validate.ts` | MEMORY/navigation coverage validation |
