# Agent Note: 前端 navigation 接受字面 `$` 路由段与 `export *` barrel

Status: implemented

[English](2026-10-14-frontend-navigation-validation.md) | 中文

## Problem

navigation 索引拒绝了两种合法的前端形态，尽管发现流程已正常索引它们。`src/context/validate.ts` 中的精确路径守卫 `isExactPath`，以及 `src/context/fallback.ts` 中的模块根守卫 `concreteDirectory` 与已知路径守卫 `exactFilePath`，把 `$` 当作结构字符，因此形如 `apps/case/src/pages/case/detail/$caseId/index.tsx` 的 TanStack Router 风格路由在索引校验时以 `expected an exact regular file path` 失败；`ai-workflow init <project>`、`context validate --all` 与 `context locate` 无法索引或解析该路由，fallback 授权也以 `expected a concrete project directory` 或 `expected an exact known file path` 阻断同样的字面 `$` 模块根与已知文件路径。此外，`validateTypeScriptSymbol` 中的特性校验只合并文件自身的顶层与嵌套声明，并假设被引用的符号必须直接声明在该文件内，因此生成 barrel 以相对 `export * from './schema.js'` 再导出的公共定义被报告为 `Navigation index is stale: <file> no longer contains <name>`，尽管该 barrel 导出了它。生成的关系必须把端点保持在 barrel 上，因此该定义只能通过跟随 star 再导出到达。

## Decision

- 精确路径语法不再把 `$` 当作结构字符。`src/context/validate.ts` 中的 `isExactPath`，以及 `src/context/fallback.ts` 中的 `concreteDirectory` 与 `exactFilePath`，从被拒绝字符类中移除 `$`，同时保留 `?`、`*`、`[`、`]`、`{`、`}`、`<` 与 `>`，因此字面 `$` 路由段对索引校验与 fallback 授权而言都是精确路径。
- 特性校验通过相对 `export *` barrel 再导出传递地解析公共符号。私有 `starExportDeclarations` 遍历实际文件上的 `export *` 声明，复用私有 `moduleFileCandidates` 的候选顺序，并携带真实路径的 `visited` 集合以终止循环；`declarations` 辅助函数接收 `includeDefault` 标志，跳过默认导出的语句，因此默认导出绝不会从 `*` 解析。仅当 `visibility === 'public'` 且直接声明集合已失败时才运行该解析。
- 其余不变。生成仍索引 barrel，生成的关系端点仍保持在 barrel 上，完整语义校验器与导出 API 保持不变；`moduleFileCandidates` 以相同的候选顺序从 `directImports` 中提取，因此解析出的关系与完整符号集与之前一致。

## Alternatives considered

- **重写或重命名携带 `$` 的产品路由。** 放弃：`$` 是合法的文件系统字符，且字面路由目录是交付的产品形态，因此校验器必须接受它，而不是改变产品。
- **把 star 再导出对应的生成关系重新指向定义文件。** 放弃：特性校验与完整校验必须读取同一个索引，且相对 `export *` 并非显式命名再导出，因此关系端点保持在 barrel 上，只有符号解析跟随 star。
- **重新设计 CLI 或校验器表面。** 放弃：该缺陷是有界的守卫与私有辅助函数修复，因此 CLI 重新设计超出了意图。

## Consequences

- 路由字面包含 `$` 的前端项目可被索引、校验与定位：`ai-workflow init <project>` 索引该路由，`context validate --all` 接受该索引，`context locate --feature <id> --verify` 为该路由特性返回命中，fallback 授权接受同样的字面模块根与已知路径。
- 特性校验接受通过相对 `export *` barrel 到达的公共定义，而从 barrel 指定的 `default` 导出或非导出定义仍无法解析，且实际重命名或移除的定义仍报告 stale 消息。
- 回归覆盖位于既有的 `tests/integration/navigation-locate-cli.test.ts`、`tests/unit/navigation-contract.test.ts`、`tests/unit/navigation-fallback.test.ts` 与 `tests/unit/navigation-semantic.test.ts` 用例中，以项目的 vitest 命令运行；既有的非法 glob 负向守卫保留。此处不报告测试执行结果。
- 没有任何活动记录被整体或部分取代：[navigation 候选测试覆盖记录](2026-09-25-navigation-candidate-tests-coverage.md) 掌管此前的候选刷新缺陷并保持其决定，本次变更既不删除也不改变它。
