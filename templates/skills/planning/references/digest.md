# Frozen-plan digest protocol

This is the normative digest convention for English `spec.md` and `plan.md`; Chinese `.zh.md` bytes never affect a digest.

1. Each document has its own frontmatter `digest` value.
2. To calculate it, use the exact UTF-8 bytes of that document after replacing only its own top-level frontmatter digest line with `digest: ""`. Preserve every other byte, including YAML ordering, whitespace, line endings, and body text.
3. Calculate SHA-256 and store it as `sha256:` followed by 64 lowercase hexadecimal characters, replacing the blank value. Never hash the completed self-referential document without blanking its digest first.
4. The workflow plan input digest is the SHA-256 of stable JSON with this exact shape: `{"plan": "<plan.md digest>", "spec": "<spec.md digest>"}`. Object keys are sorted lexicographically and strings use JSON escaping.

After both language sides and English digests are final, `ai-workflow plan pairing --plan <directory> --write spec plan` records the English/Chinese blob pairs in `<doc>.i18n.yaml`; then `ai-workflow plan validate --plan <directory>` recomputes document digests, verifies the pairs and checks the combined workflow input digest. These are the shared verification entry points; follow Planning's numbered workflow for the freeze gates.
