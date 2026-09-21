# Query Plan Studio — 计划回归门控工作台

在查询计划工作台中保存参数样例集，对新旧优化器产出的计划做回归门控。门控结合三类检查，全程不连接真实数据库：

- **结构变化**：新旧计划树的算子序列 diff（含连接重排、索引/全表扫描切换）。
- **估算行数误差**：新优化器的估算行数 vs 由统计信息推导的"实际"行数。
- **执行测量**：可注入的测量器（`Measurer`），默认实现为确定性的成本模拟，支持超时与取消。

## 运行

```bash
npm install
npm run dev      # tsx 服务端 :4174 + vite 前端 :4173
npm test         # vitest
npm run build    # tsc --noEmit && vite build
```

## 模型与约定

- 服务端固定 schema（`FIXED_SCHEMA`）；统计信息与阈值规则均为带 revision 的快照，历史版本保留。
- 启动门控时钉住 `paramSetRevision` / `statsRevision` / `rulesRevision`；运行中途更新统计不影响在途运行。
- 阈值规则：`defaults` + 按查询标签的 `overrides`；阈值含边界（误差恰好等于阈值视为通过）。
- 每个样例独立执行，单运行内并发受限（默认 2，可配置）；多个门控可同时运行、互不影响。
- 样例终态：`passed` / `failed`（有效成对）与 `invalid`（计划或测量失败，如超时）/ `skipped`（取消后未运行）。
- 汇总（`summary`）只统计有效成对；`invalid`/`skipped` 不进入误差与耗时聚合。
- 发布要求 `run.rulesRevision === 当前规则 revision`，否则 409 `stale_rules_revision`；取消的运行不可发布。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/api/param-sets` | 列出 / 新建参数集 |
| GET/PUT | `/api/param-sets/:id` | 读取 / 条件更新（revision 冲突返回 409） |
| GET/PUT | `/api/stats` | 当前统计 / 提交新 revision |
| GET | `/api/stats/:revision` | 读取历史统计快照 |
| GET/PUT | `/api/rules` | 当前规则 / 提交新 revision |
| POST | `/api/gates` | 启动门控 `{paramSetId}` |
| GET | `/api/gates` `/api/gates/:id` | 运行列表 / 详情 |
| GET | `/api/gates/:id/events` | SSE：`snapshot` → 多个 `sample` → `done` |
| POST | `/api/gates/:id/cancel` | 取消（在途测量被中止，未启动样例记为 `skipped`） |
| POST | `/api/gates/:id/publish` | 发布（校验规则 revision） |

前端通过 SSE 流式接收样例结果，并按 `index` 放回原顺序展示；失败样例展示具体证据（结构 diff、估算误差、耗时比、超时等）。
