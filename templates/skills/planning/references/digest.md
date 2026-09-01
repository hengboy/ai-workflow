# Frozen-plan digest protocol

This is the normative digest convention for `spec.md` and `plan.md`.

1. Each document has its own frontmatter `digest` value.
2. To calculate it, use the exact UTF-8 bytes of that document after replacing only its own top-level frontmatter digest line with `digest: ""`. Preserve every other byte, including YAML ordering, whitespace, line endings, and body text.
3. Store the result as `sha256:` followed by 64 lowercase hexadecimal characters. Never hash the completed document without removing its digest value first.
4. The workflow plan input digest is the SHA-256 of stable JSON with this exact shape: `{"plan": "<plan.md digest>", "spec": "<spec.md digest>"}`. Object keys are sorted lexicographically and strings use JSON escaping.

Planning writes both files with `digest: ""`, calculates each document digest, replaces the blank value, then runs `ai-workflow plan validate --plan <directory>`. The validator recomputes both document digests and the combined workflow input digest using this same protocol.
