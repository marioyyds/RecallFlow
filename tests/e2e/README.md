# E2E 测试（真浏览器）

**真的起一个 Chromium、真的把扩展装进去、真的开一个网页、真的让 Agent 跑完一整轮**，
然后断言页面上发生的事 —— 而不是断言函数返回值。

单测把 `chrome` / `cdp` / `fetch` / `ctx` 全换成假的；这里一个都不换。

完整指南（原理、操作手册、验不了什么、缺陷复盘）见
[`docs/e2e-testing-guide.md`](../../docs/e2e-testing-guide.md)。本文件只讲**这个目录怎么用**。

## 目录内容

| 文件 | 作用 |
| --- | --- |
| `golden.spec.mjs` | 黄金任务 7 条：role+name 点击 / 跨域 iframe / 审批拒绝 + 阳性对照 / `type_text` value / CDP 坐标点击 / **思考记录穿插顺序** |
| `resume.spec.mjs` | 断线恢复 1 条。**独立文件**，因为它要求夹具把第一次 LLM 调用挂起 |
| `helpers.mjs` | 两个 spec 共用的启动、设置、面板操作与 **shadow DOM 查询**工具 |
| `fixtures/server.mjs` | 三个真 HTTP 服务：主站 7802 / 跨域框架站 7803 / **模拟 LLM 7804** |
| `playwright.config.mjs` | Playwright 配置（`workers: 1`、`fullyParallel: false`） |
| `../../scripts/run-e2e.mjs` | 入口脚本：三项前置检查 + **分两阶段**跑 |

## 怎么跑

```bash
node scripts/run-e2e.mjs          # 等价于 npm run test:e2e
```

前置条件（脚本会自己检查并给出安装命令）：

1. `@playwright/test` 已安装；
2. Playwright 的 Chromium 二进制已安装（`npx playwright install chromium`）；
3. **有真实显示**。`headless: false` 是技术约束不是偏好 —— 实测 headless 下 MV3 扩展的
   service worker 根本不注册，扩展起不来。Linux CI 上要 `xvfb-run -a node scripts/run-e2e.mjs`。

分两阶段跑（各自设置环境变量 `E2E_LLM_HOLD_OPEN`）：

| 阶段 | spec | 夹具模式 |
| --- | --- | --- |
| 黄金任务 | `golden.spec.mjs` | 模拟 LLM 正常返回 |
| 断线恢复 | `resume.spec.mjs` | 把**第一次**调用挂起，确定性造出"流进行中"的窗口 |

**为什么必须分进程**：混在一起时"第一次调用"归谁取决于执行顺序，实测会时好时坏。

## 五个真踩过的坑

### 1. `page.evaluate` 穿透不了 shadow DOM

面板整个在 shadow root 里。这里有两套 API，行为**不一样**：

```js
// ✅ Playwright 的 locator 会穿透 shadow root
await page.locator(PANEL + ' .think-block').count();

// ❌ 原生 DOM API 不会穿透 —— 拿到 null / 空数组
await page.evaluate(() => document.querySelector('.agent-flow'));
```

**症状很误导**：断言收到空数组，看起来像"面板里没有子元素"，实际是**查错了树**。
用 `helpers.mjs` 里的 `flowOrder` / `panelText` / `panelStyle` / `panelVisible`，它们已经把
`host.shadowRoot` 这一步收好了。

### 2. 别用 `page.locator(...).textContent()` 断言"有没有"

面板是流式渲染的，元素先出现、内容后到。用 Playwright 的自动重试断言：

```js
await expect(page.locator(PANEL + ' .think-block')).toHaveCount(2, { timeout: 30_000 });
```

### 3. 断言"页面上真的发生了"，不要断言"工具说成功了"

`"工具返回 ok"` 和 `"页面真收到了点击"` 是两件事。夹具页面自己在 JS 里置标志位：

```js
await expect.poll(() => page.evaluate(() => window.__clicked), { timeout: 30_000 }).toBe(true);
```

跨域那条更极端：要断言 **iframe 内部那个 window** 的状态。

### 4. 只断言"有几块"会漏掉"顺序错了"

思考记录那次就是这样：块数对（2 块），但第一块是空的、且顺序全堆在最上面。
**数量与顺序是两个性质**，都要断言：

```js
expect(await flowOrder(page)).toEqual(['think', 'content', 'think']);   // 顺序
expect(await flowOrder(page)).not.toEqual(['think', 'think', 'content']); // 反证没有堆到最前
```

### 5. 负例必须配阳性对照

「拒绝审批后按钮没被点」单独看是**证明不了什么**的 —— 点击本身失败也会得到同样结果。
所以 `golden.spec.mjs` 里有配对的一条：同样指令、同样位置，点「允许一次」，断言按钮**真的**被点了。
有了一对，"批准就会点、拒绝就不会点"才成立。

## 新增一条场景要改两个地方

1. **夹具**（`fixtures/server.mjs`）：按 `userText` 加一个分支，返回脚本化的 SSE 分片。
   用现成的 `textDelta` / `toolCallDelta` / `reasoningDelta` 拼。
2. **spec**：写一条 `test(...)`，用 `sendInstruction(page, '你的触发词')` 下指令。

触发词是**选择剧本**的开关，不只是输入一句话。详细步骤见
[完整指南的「怎么新增一条场景」](../../docs/e2e-testing-guide.md#怎么新增一条场景)。

## 第三层：真模型 eval 不在这里

本目录是**第一层（能力验收）**与**第二层（技能契约）**的所在：脚本替模型做决定，回答「这套能力成不成立」。

它**回答不了**「技能文案对真模型有没有用」——因为决定是脚本做的。那在隔壁：

```text
tests/e2e-eval/               真模型 eval（模型自己决定用哪些工具）
scripts/eval-real-model.mjs   入口（前置检查 + 设置代理环境变量）
```

那一层**不进 CI**：花钱、结果非确定。完整设计（三层分工、剧本格式、断言该写在哪、真模型 eval 的纪律）见
[docs/e2e-testing-guide.md](../../docs/e2e-testing-guide.md) 第九节。
