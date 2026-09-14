# Project memory

## Standards

- Install resolves `output_language` before writes and injects it into `planning`, `plan-to-tasks`, `coding` and `documentation-maintainer`; ADR natural-language prose follows it, while structural elements, field names, `Status`, `Supersedes`, `NNNN-kebab-title.md` and `superseded-by ADR-NNNN` remain English. This is a user preference and prose-language inconsistency is not merge-blocking; changing it requires reinstalling.
- ADRs are local artifacts under `.ai-workflow/adr/`; use `ai-workflow adr list --project <root>` rather than individual ADR numbers.
- Navigation JSON is authoritative and Markdown is generated from it.
