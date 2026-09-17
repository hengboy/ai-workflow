# ai-workflow project loading

Before project work, identify the project root. If it contains `.ai-workflow/`, explicitly read `.ai-workflow/AGENTS.md` relative to that root and follow its contract for the entire project and every participating agent, including sub-agents. Do not assume the host recursively loads hidden directories or automatically follows Markdown links.

If the project contract is missing, report the missing `.ai-workflow/AGENTS.md` and direct the user to `ai-workflow init <project-root> --upgrade`. Stop project work until the contract is available; do not treat the project as fully initialized or fall back to an old global contract.

If the project root has no `.ai-workflow/`, do not load or apply ai-workflow rules.
