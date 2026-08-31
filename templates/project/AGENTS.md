# Project agent constraints

- File Explorer exclusively performs repository discovery and maintains MEMORY/navigation when boundaries change.
- Git Operator exclusively executes Git and owns worktrees. Before each commit it uses the installed `$git-message` skill to generate the message.
- All other roles stay inside packet read/write scopes and allowed commands.
- Screenshots belong in `ai-workflow/plans/<planId>/screenshot/`.
