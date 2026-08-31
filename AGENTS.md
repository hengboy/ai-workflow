# AI Workflow repository guidance

- Use Node.js 22+, pnpm, strict TypeScript ESM and Vitest.
- Keep the product self-contained. Never add an ai-team runtime dependency or invoke ai-team from product code.
- JSON Schemas in `schemas/` are authoritative; regenerate `src/generated/` after changes.
- Repository discovery belongs to the installed File Explorer role. Git mutation belongs to Git Operator.
- Preserve `.idea/` as unrelated, untracked user content.
- Screenshots created by workflow tests must stay under the active plan's `screenshot/` directory.
