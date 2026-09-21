# Plan Regression Gate Workbench

在查询计划工作台中保存参数样例，对新旧两个优化器产生的计划做回归门控。
全程使用固定的内存 schema / 统计信息与假执行器，**不需要连接真实数据库**。

## 门控模型

每个参数样例独立执行，分别跑旧 / 新两个假优化器，产出三组检查：

1. **结构变化（structure）**：规范化计划形状（算子 + 表，忽略估算值）比较；
   可按查询标签用 `structureChangeAllowed` 放行预期的计划切换。
2. **估算行数误差（estimated_rows）**：`|newEst - actual| / actual` 与阈值
   `maxEstErrorRatio` 比较（边界包含：恰好等于阈值视为通过）。估算缺失
   （任一侧为 `null`）直接给出证据并标记为**无效对**，不进入汇总。
3. **执行测量（measurement）**：测量函数可注入；超过
   `measurementTimeoutMs` 记为 `measurement_timeout` 错误。

阈值规则 = 全局默认 + 按查询标签覆盖（`RuleSet.labels`）。

汇总**只使用有效成对结果**（两个计划都产出、测量成功、估算均存在）：
给出有效对数、失败对数、排除数和最大新侧估算误差；取消后未运行的样例
单独计数（`notRun`），与失败严格区分。

## Revision 与发布

- 参数集（parameterSet）、规则集（rules）、统计信息（stats）各自带
  revision；保存走乐观并发控制，旧 revision 写入返回 409。
- 每次运行启动时**快照**三个 revision（以及固定 schema）；运行途中刷新
  统计信息不会影响在跑的运行。
- 发布（publish）要求运行已完成、门控通过，且运行使用的规则 / 参数集
  revision 与当前一致。规则更新到新 revision 后，旧运行发布返回
  `stale_rule_revision`，必须用新规则重新跑。
- 全进程最多同时运行 **2 个门控**（每门控内部再限制样例并发数，1–8）；
  第三个启动请求返回 `run_capacity_exceeded`。

## 流式接口

- `POST /api/runs` 启动门控，`GET /api/runs/:id/events` 为 SSE：
  `run_started` → `sample_started` / `sample` → `done`。
- 事件按完成时机到达，但服务端结果数组按**样例原始顺序**落位；前端表格
  始终按原顺序渲染，另用「Streamed #」列展示实际到达次序。
- 取消时在飞样例通过 `AbortController` 中止并记为 not-run，未领取的样例
  一律 not-run，不会被算成失败。晚订阅者会收到完整缓冲重放。

## 预置样例覆盖的场景

`ps-main` 自带 8 个样例，对应回归门控的各类情形：

| 样例 | 场景 |
|---|---|
| s-plan-change | 新优化器换用索引（标签级放行结构变化），新估算更准 |
| s-slow-report | 结构变化未放行 → 失败 |
| s-lookup | 完全一致的点查，通过 |
| s-missing-estimate | 双方估算缺失，失败且为无效对 |
| s-timeout | 测量超过 200ms 超时 |
| s-boundary | 误差恰好 0.25，验证边界包含 |
| s-param-north / s-param-south | **同一标签、参数不同导致不同计划** |

## HTTP API 摘要

```
GET  /api/catalog                         固定 schema 与标签目录
GET  /api/state                           统计/参数集/规则 revision
POST /api/parameter-sets                  新建参数集
PUT  /api/parameter-sets/:id/samples      保存样例（带期望 revision）
DELETE /api/parameter-sets/:id/samples/:sid
PUT  /api/rules/:id                       更新规则（409 on stale revision）
POST /api/stats/refresh                   刷新统计（bump revision）
POST /api/runs                            启动门控 {parameterSetId, concurrency}
GET  /api/runs / /api/runs/:id            运行列表 / 详情
POST /api/runs/:id/cancel                 取消
POST /api/runs/:id/publish                发布（revision 守卫）
GET  /api/runs/:id/events                 SSE 事件流（支持重放）
```

## 开发

```bash
npm install        # 若官方 registry 不稳定：--registry=https://registry.npmmirror.com
npm test           # vitest：gate / runner / api 三层共 26 个用例
npm run build      # tsc --noEmit + vite build
npm run dev        # tsx server (4174) + vite (4173, 代理 /api)
```

测量函数通过 `RunnerDeps.measure` 注入（`MeasureFn`），默认实现按标签/
参数推导实际行数、用 `delayMs` 模拟慢执行；替换为真实 EXPLAIN ANALYZE
采集器即可接入实际数据库，门控逻辑无需改动。
