# Agent Note: Navigation 候选刷新应用分析器的测试分类

Status: implemented

[English](2026-09-25-navigation-candidate-tests-coverage.md) | 中文

## Problem

受认可的 navigation 刷新流程无法分类新加入的测试文件。`src/context/validate.ts` 中的 `createNavigationCandidate` 通过赋值 `entries`、`related_files`、`symbols` 与 `relations` 从分析器结果重建每个变更特性，但从未赋值分析器的 `tests` 数组，因此生成的候选保留了权威索引中过期的 `tests` 值。当变更的模块根包含诸如 `tests` 的测试模块根时，`context refresh --write` 随后在 `validateModuleCoverage` 以 `Navigation index is stale: unclassified module file tests/...` 失败，因为新测试文件存在于磁盘上，却不出现在任何特性的 `tests`、`entries`、`related_files` 或符号文件中，派生的 `read_scope` 也继承了同样的缺口。该失败阻断了项目契约与 MEMORY 在公共符号与路径变化时要求的索引更新。

## Decision

- `createNavigationCandidate` 直接应用分析器的结果：`current.tests = [...new Set(candidate.tests)].sort(compareStrings)`，重新计算的 `read_scope` 与 `current.entries`、`current.related_files` 一起包含 `current.tests`。`src/context/discovery/typescript.ts` 中的分析器已经通过 `DiscoveryCandidate.tests` 为每个模块根返回正确的测试分类；缺失的只是赋值。
- 验证是 `tests/integration/navigation-refresh-cli.test.ts` 中的回归用例 `classifies a new test file when generating a candidate for a test module root`：它为带新测试文件的 `tests` 模块根生成候选，断言生成的 `tests` 数组，然后运行 `context refresh --write` 与 `context validate --all`；刷新后的索引以 `{"valid": true, "errors": []}` 通过 `context validate --all`。

## Alternatives considered

- **手工编辑 `.ai-workflow/index/navigation.json` 与 `.ai-workflow/index/navigation.md`。** 放弃：权威索引由受认可的流程掌管，手工编辑会绕过候选校验、授权根边界以及候选的维护授权。
- **改造分析器的根，使测试模块根以不同方式分类。** 放弃：分析器已经为 `tests` 模块根返回正确分类，缺失的赋值是唯一缺陷，改造分析器会为一个已经工作的场景增加行为。
- **保留过期索引并接受校验失败。** 放弃：项目契约与 MEMORY 要求公共符号与路径变化时更新 navigation 索引，因此过期索引应阻断变更，而不是可接受的终态。

## Consequences

- 授权测试模块根下的新测试文件会被刷新流程分类：生成的候选不再保留过期的 `tests` 数组，`context refresh --write` 成功，`context validate --all` 报告 `{"valid": true, "errors": []}`。
- `read_scope` 与分类保持一致，因为它由 `entries`、`related_files` 与 `tests` 派生，因此测试特性的读者可以到达新测试文件。
- 重新生成的索引还吸收了授权模块根内其余漂移，包括新增的 `src/install/opencode-version.ts` 与 `src/workflow/order.ts` 模块、它们的公共符号与关系，以及六个此前未分类的测试文件，例如 `tests/behavior/plan-execution-order.test.ts` 与 `tests/unit/workflow-execution-order.test.ts`。
- 没有任何活动记录被整体或部分取代：[任务执行顺序记录](../process/2026-09-25-task-execution-order.md) 掌管发现此缺陷的拆分排程并保持其决定，且没有任何活动记录掌管 navigation 候选刷新流程。
