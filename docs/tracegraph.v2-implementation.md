# tracegraph.v2 实现状态

## 开关与回滚

设置对象为 `aiSettings.traceGraph`：

```ts
{
  enabled: false,
  mode: 'record',
  shadowMode: true,
  ttlMs: 30 * 60 * 1000
}
```

- `enabled:false`：不录制、不读取图，原 JEV/慢思考路径保持不变。
- `mode:"record"`：只录制结构化前后证据并增量构图。
- `mode:"live"` + `shadowMode:false`：JEV 在 edge head 选边或弃权；选边后在
  当前快照重新解析语义目标并使用当前 ref，然后直接执行。edge 快路径不再运行
  R3、φ⁻、逐次审批或 φ⁺ 验证。
- `mode:"live"` + `shadowMode:true`：只记录 edge 决策，不产生动作；不能据此
  宣称节省或准确率收益。

一键回滚：把 `traceGraph.enabled` 设为 `false`。图数据留在
`chrome.storage.local` 的 `recallflow.tracegraph.v2`，可在后续重新开启读取。

## 设置页可视化

「设置 → 轨迹复用」内置可交互图编辑器：

- 按站点 origin 切换图；
- 展示状态模板、可执行边、原始记录数和更新时间；
- 点击状态节点高亮相邻边，并展示工具、目标、风险、slot 和参数模板；
- Canvas 渲染替代 SVG；图会按画布尺寸自动缩放并居中，拖拽背景平移、滚轮缩放；
  节点和边都可直接拖动调整布局，模态提供
  `缩小 / 居中 / 放大 / 当前倍率` 控件；
- 未验证边使用虚线；图不再因 TTL 过期而失效，所有本地保存的图都可读取和提名；
- 支持删除整站图、单条边，或删除节点及其全部关联边；对应录制证据同步移除；
- 刷新按钮和 `chrome.storage` 变更会更新视图。

可视化只操作已经脱敏的本地图数据，不执行边。拖动布局只是查看态，不写回图数据；
删除操作会持久化到 `chrome.storage.local`。

## 测试入口

```bash
node --test tests/tracegraph/*.test.mjs
node scripts/r3-replay-eval.mjs --cases=13 --defects=6
node scripts/eval-jev-real.mjs --head=edge --grid
```

前两条是离线分析；R3/φ 函数保留用于历史回放与诊断，但不再进入 live edge
controller。第三条需要 `TYPESAFE_API_KEY`，没有真实请求时不得把网格推荐值
写成实测结论。

## P4 状态

Patcher 白名单已实现。`macro(op=run)` 尚未切换到 edge 引擎：规格要求先完成
live A/B 并满足 go/no-go（尤其错写为 0、慢思考下降 ≥50%）。当前没有真实
基线，因此保留原宏回放路径，避免把未验收的图决策变成批量执行入口。

## 2026-11-10 live 灰度后的优化

- edge 身份不再包含 PlanCard 文案；相同目标在不同计划措辞下会合并。
- 动作录制新增真实 `target`：控件 role/name/selector，或 `open_tab` 的 URL pattern。
- 旧 edge 在读取/设置页打开时从保留 records 重建；工具名相同但目标不同的动作
  保留为平行边，并显示目标摘要。
- edge 快路径新增当前快照 Grounding：按 role/name 唯一匹配目标并使用当前 ref；
  目标缺失、歧义、隐藏、禁用或语义不符时交回慢思考。
- live edge 执行不再使用 R3、φ⁻、逐次审批或 φ⁺ 验证；JEV 选边并通过 Grounding
  后直接执行。
- 状态名和 URL pattern 改为应用级模板，不再按商品 slug / 帖子 slug 分裂。
- 槽位只从当前指令的 `@slot=value`、围栏 JSON `slots` 或显式上下文读取。
- 不可显式绑定的边在提名后、JEV 请求前被剔除。
- edge question 增加当前 PlanCard 子目标、成功谓词和实时 controls/counters/dialog，
  不再注入 φ⁻ 门禁。
- 设置页移除旧的读取 / 输入 / 点击 / 等待 / 目标分支阈值，统一为
  `minEdgeConfidence`（默认 `0.80`）；它是 edge 选边或弃权的唯一 confidence
  门限。
- 以上改动在 r3-v3 中将候选推进到 67 次可绑定状态，但 JEV 仍全部弃权，故 live
  go/no-go 仍为 no-go。
