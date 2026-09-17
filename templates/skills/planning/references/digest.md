# Frozen-plan digest protocol

This is the normative digest convention for `spec.md` and `plan.md`.

1. Each document has its own frontmatter `digest` value.
2. To calculate it, use the exact UTF-8 bytes of that document after replacing only its own top-level frontmatter digest line with `digest: ""`. Preserve every other byte, including YAML ordering, whitespace, line endings, and body text.
3. Store the result as `sha256:` followed by 64 lowercase hexadecimal characters. Never hash the completed document without removing its digest value first.
4. The workflow plan input digest is the SHA-256 of stable JSON with this exact shape: `{"plan": "<plan.md digest>", "spec": "<spec.md digest>"}`. Object keys are sorted lexicographically and strings use JSON escaping.

Planning writes the English `spec.md` and `plan.md` with `digest: ""`, calculates each document digest over its exact UTF-8 bytes, and replaces the blank value. The English bytes are the only digest source; the Chinese `.zh.md` side never affects the digest. Both language sides and the English digests are final before recording the pair: run `ai-workflow plan pairing --plan <directory> --write spec plan` to record each English/Chinese blob pair in `<doc>.i18n.yaml`, then run `ai-workflow plan validate --plan <directory>`. The validator recomputes both document digests, verifies the recorded pair, and checks the combined workflow input digest using this same protocol.
