# Agent Note: 双语 note 配对与一致性记录

Status: implemented

[English](2026-09-17-bilingual-note-triplets.md) | 中文

## Problem

此前 notes 是单语言的：每篇 note 正文遵循配置的 `output_language`，治理规则明确禁止翻译副本与 sidecar。不与作者同语言的读者没有受维护的对照文本，note 被修改后没有任何机制发现它与另一种语言已经不一致，也没有记录两侧最后一次达成一致的状态。此前的[项目契约与 Agent Notes 替代记录](./2026-09-16-project-contract-and-agent-notes.md)有意选择了单语言模型，因此改变它需要一条新记录，而不是改写旧决定。

## Decision

- 每篇 note 在同一目录下是三个同级文件：英文 `{topic}.md`、中文 `{topic}.zh.md` 与 `{topic}.i18n.yaml` 一致性记录。两种语言地位平等，必须表达同一含义。
- 两个正文都保留英文结构性元素——`# Agent Note:` 前缀、段落标题、字段名、`Status` 及其取值、路径与日期——只翻译正文。在头部块之后、`## Problem` 之前，英文正文带有标签为 `中文` 的切换行并链接到 `{topic}.zh.md`，中文正文带有标签为 `English` 的切换行并链接到 `{topic}.md`。
- `<topic>.i18n.yaml` 包含一段头注释和恰好两行，把每一侧的 basename 映射到上次确认一致时记录的 git blob hash。该 hash 是 git blob SHA-1（`sha1("blob <length>\0" + bytes)`），直接计算而不调用 git。
- 三件套是无条件的：没有任何配置选择 notes 或规划产物的语言，两个产物族始终都写成完整的双语三件套；`output_language` 键随后由 2026-09-18 的[移除 output_language 记录](../simplification/2026-09-18-remove-output-language.md)整体移除，见[规划产物三件套记录](./2026-09-17-bilingual-planning-artifacts.md)。
- `ai-workflow notes list` 报告每篇 active note 的英文正文；`ai-workflow notes validate` 额外校验三件套完整性、语言切换行、镜像的标题/代码/表格/列表/链接签名、已记录 hash、active 链接与归档完整性；`ai-workflow notes pairing` 校验配对，`--list` 报告 `missing`、`out-of-sync` 或 `ok`，`--write <note>` 或 `--write --all` 记录当前字节。
- 归档封存把每个归档三件套的三个产物都登记进 `archived/manifest.json`，校验要求归档产物与清单条目一一对应。
- 随产品发布的 `templates/project/notes/README.md` 治理、`documentation-maintainer` 角色、`MEMORY.md` 与 `README.md` 在同一变更内描述同一套三件套契约。

## Alternatives considered

- **保留单语言 notes 并依赖 `output_language`。** 放弃：它没有受维护的对照文本、没有漂移检测、也没有一致性状态，而本次变更正是要修复这一点。
- **记录内容 `sha256` 而不是 git blob hash。** 放弃：需求是与参考项目的 `i18n.yaml` 保持一致，其 blob hash 格式可以与 `git hash-object` 的输出直接比对。
- **为结构签名引入 Markdown AST 依赖。** 放弃：针对受限 note 格式的有界逐行签名同样能发现标题、代码、表格、列表与链接的分歧，且不需要新依赖。
- **让 `output_language` 选择作者先写的语言，同时仍然产出两侧。** 放弃：两种语言地位平等，排出主次的偏好会与配对契约冲突，并让旧的单语言假设继续存在。
- **复刻参考项目完整的配对契约，包括其 merge driver 与翻译简报。** 放弃：那些机制绑定该仓库的 Git 托管与翻译工具；notes 需要的是三件套、已记录 hash、切换行与结构校验。

## Consequences

- 一篇 note 要么是完整配对，要么无效：缺失 `.zh.md` 或 `.i18n.yaml`、缺失或错误的语言切换行、结构分歧、过期的已记录 hash 以及孤立同级文件，都会让 `ai-workflow notes validate` 失败并给出问题路径与原因。
- 重新记录是显式且可审阅的动作：`--write` 要求给出已确认的配对，`--write --all` 作为显式选择重录全量，因此过期 hash 绝不会被静默接受。
- 已记录的 blob hash 可以还原任一侧最后一次确认的文本，因此不一致的配对通过针对已修改一侧的最小补丁更新对照文本，然后重新记录。
- 结构被机械比对，但含义没有：校验无法判断两侧是否表达同一含义，忠实度、术语与自然措辞仍由语义审阅负责。
- `i18n.yaml` 头部指向 `.ai-workflow/notes/README.md` 与 `ai-workflow notes pairing --write` 命令，而不是某个宿主专属脚本运行器。
