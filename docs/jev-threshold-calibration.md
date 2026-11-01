# JEV 真实环境校准记录

日期：2026-11-01  
模型：`jev-latest`（服务返回 `jev-1.14.0`）

## 方法

使用 [真实校准场景](../tests/e2e/jev-scenarios.mjs) 调用远程 TypeSafe：

- 8 类场景：明确点击、歧义点击、填写标题、标题已填后填写正文、等待加载、读取正文、读取表格、仅出现高风险发布按钮；
- 每个场景重复 3 轮，共 24 个远程决策样本；
- 记录 operation/target 置信度、概率分布、延迟、正确率和错误接受情况；
- 用网格扫描目标动作分支下限与四类动作阈值；
- 再用真实 Chromium 加载扩展，执行点击、输入、异步搜索和多步表单 4 条端到端任务。

运行入口：

```powershell
$env:TYPESAFE_API_KEY = '<在运行环境中设置>'
$env:HTTPS_PROXY = 'http://127.0.0.1:7890'
node scripts/eval-jev-real.mjs
node node_modules/@playwright/test/cli.js test -c tests/e2e/playwright.config.mjs tests/e2e/jev-real.spec.mjs
```

Node 内置 `fetch` 不读取代理环境变量；校准脚本使用显式 HTTP CONNECT 隧道，因此请求出口与浏览器一致。

## 迭代与发现

### 第 1 轮

- 正确动作：点击、正文输入、等待、页面读取。
- 问题 1：文本框同时进入 `CLICK` 和 `TYPE_TEXT` 候选。“填写标题”在 3/3 轮中选择 `CLICK`，operation 置信度只有 0.46–0.57。
- 问题 2：目标 head 是条件概率，即使 operation 分支错误也可能给出 100%；歧义按钮场景因此会被错误接受。
- 问题 3：`READ_TABLE` 的真实正确置信度为 0.62–0.71，被原先 0.72 的读取阈值挡掉。

### 第 2 轮

- 将文本类 input 从 CLICK 候选中移除。
- “填写标题”改为 3/3 选择 `TYPE_TEXT`，operation 置信度提升到 0.99–1.0。
- “标题已填，继续正文”在 3/3 轮选择正确正文 target，operation 为 0.98–0.99。
- 歧义点击仍选择 `CLICK`，operation 仅为 0.67–0.73，说明不能只信 target head。

### 第 3 轮

- 增加目标动作 operation 分支下限：CLICK/TYPE_TEXT 的 target 达到门槛后，operation 仍须达到独立下限。
- 将读取阈值下调为 0.60，匹配表格读取的实测分布，同时保持只读、可逆动作的安全边界。
- 24 个样本结果：18/18 正确动作接受，0 个错误接受，6/6 歧义或高风险场景拒绝。

### 浏览器端迭代

首次真实浏览器运行中：

- 输入与多步表单通过；
- 点击和搜索失败。原因不是 JEV，而是 Mock 慢模型按“工具结果数量=第几步”推进；JEV 的观察工具改变了计数，慢模型误以为动作已完成。
- 将夹具改为按工具调用语义推进后，4/4 浏览器任务通过。

## 推荐参数

| 参数 | 默认值 | 依据 |
| --- | ---: | --- |
| `minTargetOperationConfidence` | 0.75 | 歧义点击实测最高 0.73；正确目标动作实测最低 0.98 |
| `minClickConfidence` | 0.86 | 保留条件 target 的高门槛；分支是否成立主要看 operation 下限 |
| `minActionConfidence` | 0.80 | 正确 TYPE_TEXT 为 0.98–1.0，保留泛化余量 |
| `minReadConfidence` | 0.60 | READ_TABLE 正确样本最低 0.62；读取属于可逆低风险动作 |
| `minWaitConfidence` | 0.50 | WAIT 无页面写副作用；样本为 1.0，仍保留低成本容错空间 |
| `maxElementCandidates` | 40 | 当前样本无明显候选数量瓶颈 |
| `maxRepeatedActionsWithoutProgress` | 3 | 允许页面异步更新，同时阻止无进展循环 |

## 局限

- 24 个模型样本足以发现明显分叉，不足以形成统计置信区间；
- 当前场景以本地可控页面为主，真实站点 DOM 复杂度和文案噪声更高；
- `CLICK` target head 的置信度高度饱和，后续若服务支持校准温度，应优先校准 operation head；
- 建议上线后继续按周积累影子决策，目标保持错误接受率为 0，同时观察正确动作拒绝率。
