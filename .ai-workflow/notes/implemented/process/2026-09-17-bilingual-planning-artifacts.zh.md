# Agent Note: 双语规划产物与一致性记录

Status: implemented

[English](2026-09-17-bilingual-planning-artifacts.md) | 中文

## Problem

此前的规划产物 `spec.md`、`plan.md` 与 `tasks/*.md` 是单语言的：planning 技能按配置的 `output_language` 书写正文，文档没有对照文本、没有漂移检测，也没有记录两侧最后一次达成一致的状态。[双语 note 三件套记录](./2026-09-17-bilingual-note-triplets.md)已为 Agent Notes 建立三件套契约，但其 Decision 仍称该偏好管辖生成的规划产物，因此规划产物仍是唯一被本地化的产物族。把两个产物族统一到同一套契约只改变了那一条主张，note 三件套契约本身仍然有效，因此本次决定由一条新记录承载并交叉链接既有记录，而不是改写旧记录。

## Decision

- 规划产物与 Agent Notes 采用同一套双语三件套契约：`spec.md` 连同 `spec.zh.md` 与 `spec.i18n.yaml`，`plan.md` 连同 `plan.zh.md` 与 `plan.i18n.yaml`，以及 `tasks/task-NNN-slug.md` 连同其 `.zh.md` 与 `.i18n.yaml`。
- 英文侧是唯一携带 YAML frontmatter、`REQ-###`/`AC-###` 标识、计数与内容 `digest` 的一侧；摘要语义不变。中文侧不含 frontmatter，首行为同一英文标题，随后是带有 `English` 标签、链接到英文文档的中文切换行；英文侧携带 `中文` 标签并链接到中文文档。两侧互相镜像标题、代码、表格、列表与链接结构，只翻译散文。
- `ai-workflow plan pairing --plan <目录>` 校验并记录配对。无 flag 时为只读校验，返回 `{ "valid": true, "errors": [] }`，失败时非零退出且不写任何文件；`--list` 逐份报告 `missing`、`out-of-sync` 或 `ok` 且永远退出 0；`--write` 接受 `<doc>.md`、`<doc>.zh.md`、`<doc>.i18n.yaml` 或裸的 `spec`、`plan`、`task-NNN-slug` slug，先全量预检每个显式选择的文档，任一选择不完整就不写任何记录，而 `--write --all` 只记录完整配对并跳过不完整配对。
- `ai-workflow plan validate --plan <目录>` 同时强制三件套——`.zh.md` 与 `.i18n.yaml` 伴生文件、精确切换器、镜像结构与等于当前字节的记录哈希——同时保留其 `plan_id`、计数与摘要检查及其不变的成功 JSON 形状（`valid`、`plan_id`、`digests`）。
- `readPlan` 与 `readTasks` 强制三件套，任务枚举只把 `task-NNN-slug.md` 视为主文档；没有匹配主文档的 `.zh.md` 或 `.i18n.yaml` 是孤儿并报错。
- 没有任何配置选择规划产物的语言：`output_language` 随后由 2026-09-18 的[移除 output_language 记录](../simplification/2026-09-18-remove-output-language.md)整体移除。notes 与规划产物始终是完整的双语三件套，且没有任何配置项选择它们的语言。
- 实现复用 `src/notes/pairing.ts` 中的 notes 配对原语，并新增 `src/workflow/pairing.ts` 承载计划专用的记录、枚举与校验路径。

## Alternatives considered

- **把已有的单语计划迁移为三件套。** 放弃：已有计划是历史冻结产物，翻译它们会改写已封存内容并模糊新旧格式的边界；它们保持原字节并按设计无法通过新校验。
- **保留 `output_language` 作为规划产物语言选择器，只为 notes 增加双语产物。** 放弃：这会让规划产物没有受维护的对照文本或漂移检测，与同一套双语契约冲突，并让本次要统一的产物族继续保留旧的单语言假设。
- **新增第三个配置项来选择产物语言。** 放弃：三件套是无条件的，单独开关只会增加一处配置面与第二种失败模式而没有使用场景，因为两种语言地位平等，而不是正文与译文的关系。
- **让中文侧拥有自己的 frontmatter 或按语言各有一个 `digest`。** 放弃：摘要协议与结构字段必须单一来源于英文字节，才能与既有读者、计数与 `plan validate` 输出形状保持兼容。

## Consequences

- 一份规划文档要么是完整配对，要么无效：缺失 `.zh.md` 或 `.i18n.yaml`、切换器错误、结构分歧、记录哈希过期以及孤儿伴生文件，都会让 `ai-workflow plan validate` 失败并给出问题路径与原因。
- `.ai-workflow/plans/` 下已有的单语计划按设计无法通过新校验，既不迁移也不放行。计划目录 `20260917-bilingual-planning-artifacts` 本身就是这样一件历史遗留：它在本次变更前冻结、按 unsplit 计划执行、不生成 task 文件，落地后不得用新的 `plan validate` 复验。
- 摘要协议与 `plan validate` 的成功输出形状保持不变，因此只需要 `plan_id`、计数与摘要的读者继续可用，且无需进行摘要协议迁移。
- 漂移由记录配对哈希而非摘要捕获：只改中文侧时英文 `digest` 仍然匹配，直到 `ai-workflow plan pairing --plan <目录> --write --all` 重记字节前都会报告为 `out-of-sync`。
- 结构被机械比对，含义没有：忠实度、术语与自然措辞仍由语义审阅负责。
