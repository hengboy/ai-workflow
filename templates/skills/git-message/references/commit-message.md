# Commit Message

## Template

```text
<type>(<optional scope>): <Chinese result summary>

<optional Chinese body explaining motivation, compatibility, or validation>

<optional BREAKING CHANGE: description and migration guidance>
```

Omit the scope, body, and footer when the verified change does not require them.

## Example

For a compatible installer change that preserves nested skill resources:

```text
feat(install): 安装技能附带的元数据和参考模板

为 Codex、Claude 和 OpenCode 保留技能目录中的 references 与 agents 文件。
```

For a breaking configuration rename:

```text
feat(config)!: 统一配置文件中的主机字段

BREAKING CHANGE: 将 provider 字段重命名为 host，现有配置需在升级前迁移。
```
