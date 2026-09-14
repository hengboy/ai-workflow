# Project memory

## Standards

- Install resolves `output_language` before writes and injects it into `planning`, `plan-to-tasks`, `coding` and `documentation-maintainer`; ADR natural-language prose follows it, while structure, field names and enumerated values remain English. Changing it requires reinstalling.
- ADRs are local artifacts under `.ai-workflow/adr/`; use `ai-workflow adr list --project <root>` rather than individual ADR numbers.
- Navigation JSON is authoritative and Markdown is generated from it.
