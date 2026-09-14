# 0003 Localize ADR prose at install time

Status: accepted
Date: 2026-09-14
Summary: Inject the configured `output_language` directive into Documentation Maintainer

## Context

ADR prose is authored by Documentation Maintainer, while `output_language` previously covered planning skills only. The ADR contract requires field names, `Status`, `Supersedes`, `NNNN-kebab-title.md`, and `superseded-by ADR-NNNN` to remain English.

## Decision

Inject the configured language directive into Documentation Maintainer at install time. Localize ADR natural-language values while keeping structural fields and protocol values in English.

## Consequences

ADR authoring follows the user's preference; changing it requires reinstalling. ADR structure and `adr list` output remain English.
