# 真浏览器 E2E 测试指南

> 一句话：**真的起一个 Chromium、真的把扩展装进去、真的开一个网页、真的让 Agent 跑完一整轮**，
> 然后断言页面上发生的事 —— 而不是断言函数返回值。
>
> 目录内的速查见 [`tests/e2e/README.md`](../tests/e2e/README.md)。本文讲**为什么这么设计**、
> **怎么新增场景**，以及**它验不了什么**。

## 一、它和单测的分工

| | 单元测试（`npm test`） | 真浏览器 E2E（`npm run test:e2e`） |
| --- | --- | --- |
| 环境 | Node | 真实 Chromium + 真装扩展 |
| 依赖 | `chrome` / `cdp` / `fetch` / `ctx` **全换成假的** | 一个都不换 |
| 断言对象 | 函数返回值、发出的消息 | **页面上发生的事**（DOM、计算样式、页面自己的标志位） |
| 数量级 | 1398 项，秒级 | 43 个场景，三阶段合计约 2 分钟 |
| 擅长抓 | 逻辑分支、边界、契约 | **真环境里的时序与集成问题** |
| 抓不到 | 真环境问题 | **没被写成场景的分支** |

**两者是互补的，不是重复的。** 一个具体例子：思考记录的"第一块永远是空的"这个缺陷，
1140 项单测全绿（连调度器自己的单测都过），因为它依赖**真帧循环**下两个段的排入落在同一帧。
反过来，另一个缺陷（跨作用域调用）E2E 也没抓到，是静态门禁抓的 —— 见第八节。

## 二、四个组成部分

```
┌──────────────────────────────────────────────────────────┐
│  Chromium（持久化上下文 + 真装扩展）                       │
│    --load-extension=D:\...\bookmark-sorter                │
│    --disable-extensions-except=<同一路径>                 │
│         │                                                 │
│         │ 扩展后台(background.js) ←→ 内容脚本              │
│         ▼                                                 │
│    打开 http://127.0.0.1:7802/  ← 夹具主站                 │
└──────────────────────────────────────────────────────────┘
         │ 扩展发 LLM 请求              │ 主站里嵌了个 iframe
         ▼                              ▼
   模拟 LLM :7804                 框架站 :7803（不同端口 = 真跨域）
```

三个服务都是**真的 node http server**，定义在
[`tests/e2e/fixtures/server.mjs`](../tests/e2e/fixtures/server.mjs)：

| 端口 | 是什么 | 为什么需要 |
| --- | --- | --- |
| 7802 | 主站：一个「提交」按钮、一个搜索框、**一个跨域 iframe** | 给 Agent 一个真页面去读和点 |
| 7803 | 框架站：iframe 的内容 | 端口不同 → `localhost:7802` 访问 `localhost:7803` **是真正的跨域**，iframe 路由才有意义 |
| 7804 | 模拟 LLM（OpenAI 兼容、SSE 流式） | 不用真 API：不花钱、不联网、结果确定 |

### 关键一招：模拟 LLM 走**真协议**

模拟 LLM 用**和真 DeepSeek 完全相同的协议**（`POST /chat/completions` + `text/event-stream` +
`data: {...}\n\n`），只是按用户消息内容返回**脚本化**的分片：

```js
// fixtures/server.mjs —— 场景 F：思考记录
if (userText.includes('思考')) {
  sse(res, [
    reasoningDelta('先确认页面结构，'),      // 思维链分片
    reasoningDelta('再决定点击哪个按钮。'),
    textDelta('我想好了：结论如下。'),        // 正文分片
    reasoningDelta('再复核一下边界情况。'),   // 第二段思维链（用来验证"穿插"而不是"聚成总块"）
    textDelta('补充一句。'),
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    { usage: { total_tokens: 42 } },
  ]);
  return;
}
```

**协议是真的 → 被跑到的生产代码也是真的**：`agent.js` 的 SSE 解析、事件转发、面板的流式渲染、
折叠状态机，全是生产路径。只有"模型会说什么"被换成了脚本。

而场景按 `userText` 分派，所以 spec 里 `sendInstruction(page, '说说你的思考')` 等于**选择剧本**。

## 三、怎么跑

```bash
node scripts/run-e2e.mjs          # 等价于 npm run test:e2e
```

[`scripts/run-e2e.mjs`](../scripts/run-e2e.mjs) 的自述理由：为什么不直接 `npx playwright test` ——
因为它先做**三项前置检查**，不合格就带着具体安装命令退出，而不是让你对着一个超时猜。

1. `@playwright/test` 已安装；
2. Playwright 的 Chromium 二进制已安装；
3. **有真实显示**。

### 为什么必须 `headless: false`

[`playwright.config.mjs`](../tests/e2e/playwright.config.mjs) 里记着实测结论：

> 在 Playwright 1.64 + Chromium 里用 `headless: true` 启动持久化上下文时，MV3 扩展的
> service worker **根本不会注册**（`context.serviceWorkers()` 为空、等待 `serviceworker`
> 事件超时）。扩展起不来，这套测试就无从谈起。

所以这不是"忘了开 headless"，是当前技术约束。**想在 CI 跑要一台虚拟显示**
（Linux 上 `xvfb-run -a node scripts/run-e2e.mjs`），而不是把这里改成 `true`。

### 为什么分两阶段

| 阶段 | spec | `E2E_LLM_HOLD_OPEN` | 夹具模式 |
| --- | --- | --- | --- |
| 黄金任务 | `golden.spec.mjs` | `''` | 模拟 LLM 正常返回 |
| 断线恢复 | `resume.spec.mjs` | `'1'` | 把**第一次**调用挂起 |

断线恢复需要一个**确定性**的"流已开始、尚未结束"窗口。第一版靠 `sleep` 抢时机，
但一次 run 约 600ms 就跑完了，400ms 的 sleep 竞争不过抖动，测试时好时坏；
现在改成夹具"只挂起第一次调用"，窗口就确定了。

**为什么必须分进程**：混在一起时"第一次调用"归谁取决于执行顺序 —— 这正是实测踩过的坑。

## 四、断言写什么

### 断言页面上的副作用，不是工具返回值

```js
// ✅ 夹具页面自己的 JS 置的标志位
await expect.poll(() => page.evaluate(() => window.__clicked), { timeout: 30_000 }).toBe(true);

// ❌ "工具返回 ok" 和 "页面真收到了点击" 是两件事
```

跨域那条更极端 —— 要断言 **iframe 内部那个 window** 的状态：

```js
const frame = page.frames().find((f) => f.url().includes('7803'));
return frame.evaluate(() => window.__frameClicked === true);
```

### 负例必须配阳性对照

「拒绝审批后按钮没被点」单独看**证明不了什么** —— 点击本身失败也会得到同样结果。
所以有一对配对用例：同样指令、同样位置，一条点「拒绝」、一条点「允许一次」；
后者断言按钮**真的**被点了。有了一对，"批准就会点、拒绝就不会点"才成立。

这与仓库里其它门禁的做法一致（前缀稳定性门禁也自带反例夹具，证明闸门真的会咬人）。

### 数量与顺序是两个性质

思考记录那次：**块数是对的（2 块）**，但第一块是空的、顺序还全堆在最上面。
只断言 `toHaveCount(2)` 完全发现不了。顺序性质要单独断言：

```js
expect(await flowOrder(page)).toEqual(['think', 'content', 'think']);
expect(await flowOrder(page)).not.toEqual(['think', 'think', 'content']); // 反证没有堆到最前
```

### ⚠ 但判据本身要**顺序无关**（模型可以按任何顺序做你写的步骤）

上一节说的是"顺序有时是被验对象"；这里说的是**相反的一面**：
当**顺序不由你控制**时，把它写进判据就是在验**路径**，而不是验结果。

这个坑本仓库踩过**三次**，形态各不相同：

| 场景 | 当时的写法 | 为什么错 |
|---|---|---|
| CDP 拖拽 | `__dragEnds === 1` | 模型改了路线、多拖了一次 → 结果达成却判失败 |
| 排查 | `__clicks === 1` | 模型后来又点了一次复现 → 同上 |
| 撤销 | "优先级被回退、标题保留" | 用户给的顺序是"标题→发布→优先级"，但模型**先选了优先级、后填标题** → "撤销上一步"撤的当然是标题。**这次撤销完全正确，却被判成失败** |

写法上的差别：**别断言"哪一步被撤了"，而是断言"恰好一处被撤"**（顺序无关的不变量）：

```js
// 三处可撤销改动，撤一格就只该少一格
"['title','publish','level']"
  + ".map(k => ({title:'周报',publish:true,level:'high'}[k] === window.__state[k]))"
  + ".filter(Boolean).length === 2"
```

同一条纪律：**动作计数用 `>= N`**（"确实发生过"）或 `=== 0`（"没发生过"），
不用 `=== N`（"恰好 N 次"）—— 除非次数**本身就是结果**（例：宏回放的 `__runs === 2`，
放宽成 `>= 2` 就无法区分"回放生效"与"手动做了两次"）。这两件事都有门禁盯着：
剧本侧在 `tests/skill-playbook-contract.test.mjs`，spec 侧在 `tests/e2e-hygiene.test.mjs`。

### 有些约束只有"计算样式"能证伪

"思考记录不得有内层滚动条"这种要求在 CSS 里写错**不会报错**，单测也看不到。
只有真浏览器算出来的 computed style 能证伪：

```js
const s = await panelStyle(page, '.think-block .think-body', ['overflowY', 'maxHeight']);
expect(s.maxHeight).toBe('none');
```

## 五、怎么新增一条场景

**两个地方，缺一不可。**

### 第 1 步：夹具里加一个剧本（`fixtures/server.mjs`）

按 `userText` 分派 —— 用一个**只可能出现在这条测试里**的触发词，避免和其它场景抢：

```js
// 场景 G：<一句话说明这条要验什么，以及为什么现在没有覆盖>
if (userText.includes('你的触发词')) {
  sse(res, [
    toolCallDelta('click_element', { role: 'button', name: '提交' }),  // 需要工具就加
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]);
  return;
}
```

可用的小工具：`textDelta` / `toolCallDelta` / `reasoningDelta` / `sse`。
需要多轮（工具执行完再回答）就用 `toolResults.length` 判断这是第几轮 —— 见场景 A/C/D 的写法。

⚠ **分支要放在最后的兜底场景 B 之前**，否则永远轮不到。

### 第 2 步：写一条 spec（`golden.spec.mjs`）

```js
test('golden: <一句话说清断言的是什么性质>', async () => {
  await configureSettings(context);              // 需要改设置就传 overrides
  const page = await openFixturePage(context);   // 坐标页用 openFixturePage(context, '/coord')
  await sendInstruction(page, '你的触发词');      // 触发词 = 选择剧本

  // 断言"页面上真的发生了"，用 expect / expect.poll 让 Playwright 自动重试
  await expect.poll(() => page.evaluate(() => window.__clicked), { timeout: 30_000 }).toBe(true);

  await page.close();
});
```

要点：
- **超时给足**（30s 起步）。Agent 一轮要跑意图路由 → LLM → 工具 → 收尾，链路很长。
- **用 `expect` / `expect.poll`** 而不是 `waitForTimeout` + 一次性断言（后者必然 flaky）。
  唯一用 `waitForTimeout` 的地方是"给闸门足够时间**别**做事"这类**否定**断言。
- 如果这条需要"流进行中"的窗口，它大概率应该进 `resume.spec.mjs` 那条挂起模式，而不是这里。

### 第 3 步：跑

```bash
node scripts/run-e2e.mjs
```

**如果它一次就过，先怀疑它有没有真的跑到那条分支** —— 这个仓库里"看着完成、实际从没执行到那一步"
出现过四次。可以在断言前先加一句必然失败的断言（或 `expect(order).toEqual(['故意写错'])`）
确认它确实在跑，再改回正确值。

## 六、五个真踩过的坑

### 坑 1：`page.evaluate` 穿透不了 shadow DOM

面板整个在 shadow root 里。两套 API 行为**不一样**：

```js
// ✅ Playwright 的 locator 会穿透 shadow root
await page.locator(PANEL + ' .think-block').count();

// ❌ 原生 DOM API 不会穿透 —— 拿到 null / 空数组
await page.evaluate(() => document.querySelector('.agent-flow'));
```

**症状极误导**：断言收到空数组，看起来像"面板里没有子元素"，实际是**查错了树**。
用 `helpers.mjs` 的 `flowOrder` / `panelText` / `panelStyle` / `panelVisible` ——
它们已经把 `host.shadowRoot` 那一步收好了。

### 坑 2：面板在隔离世界，`page.evaluate` 看不到它的全局变量

panel 的脚本跑在隔离世界。要断言面板内部状态，走**跨世界事件**：

```js
// resume.spec.mjs 的做法：面板派发 CustomEvent，页面侧监听
await page.evaluate(() => {
  window.__rfE2EDropped = false;
  window.addEventListener('__RF_E2E__dropped', () => { window.__rfE2EDropped = true; });
});
```

### 坑 3：`waitForTimeout` + 一次性断言 = flaky

用 `await expect(...)` / `await expect.poll(...)` 让 Playwright 自己重试。
唯一合理用 `waitForTimeout` 的场合是**否定断言**（"给它时间别做某件事"）。

### 坑 4：夹具页改动会波及别的场景

第一版把固定定位的坐标目标 `#hit` 加进了主站，结果「role+name 点击提交」那条黄金任务开始失败
（点击本身没问题，但没生效）。为把变量降到最少，**坐标目标独立成页**（`/coord`），
黄金任务的夹具保持原样不动。

**教训**：改夹具时要假设它会波及所有场景。

### 坑 5：`--load-extension` 的路径必须指向仓库根

而且 `--disable-extensions-except` 要设成同一个路径，否则同机其它扩展也会被加载进来，
干扰结果。这两条都在 `helpers.mjs` 的 `launchExtension()` 里。

## 七、它验不了什么（诚实清单）

| 验不了 | 原因 |
| --- | --- |
| 真实 DeepSeek 的字段名与边界行为 | 夹具是模拟的。例如 `reasoning_content` 若在某些网关叫 `reasoning`，这里永远发现不了 —— **必须真实跑一次才能确认** |
| 无头 CI | MV3 service worker 在 headless 下不注册（除非用 xvfb） |
| **没被写成场景的分支** | 它只覆盖写了的 10 个场景。"流式中重开面板"就没被覆盖，而那里正好藏着一个缺陷（第八节） |
| 性能/卡顿 | 断言的是"最终发生了"，不是"多快发生" |
| 打包产物是否最新 | 那是 `tests/silent-failure-regressions.test.mjs` 与 `scripts/build-content.mjs --check` 的事 |
| **技能文案对真模型有没有用** | 见第九节。夹具里的"模型"是脚本，它在测试里替模型做了决定 |

**最重要的一条**：E2E 只覆盖**你写下来的场景**。
所以每次新增能力时都要问一句"这个能力有没有一条 E2E 会走到它"。

## 八、案例复盘：思考记录那一轮的三个缺陷

这一轮很典型，三个缺陷分别被**三层不同的东西**抓到 —— 说明没有哪一层是多余的。

### 缺陷 1：思维链从来没被读过（需求层）

`streamAgentStep` 只处理 `delta.content` 与 `delta.tool_calls`，
推理模型的 `delta.reasoning_content` 被**直接丢弃**（全仓库对它零引用）。
所以"模型思考时界面没有记录"是**必然**的，加动画也治不了。

→ 抓到它的方式：读代码 + 全仓库 grep 字段名。**任何测试层都抓不到"没实现的需求"**。

### 缺陷 2：渲染合并器的 key 冲突（E2E 抓到）

`pushReasoning` 与 `finishReasoning` 共用 key `'reason'`，
而 [`render-scheduler.js`](../lib/page/render-scheduler.js) 是**按 key 去重**的（同 key 只保留最后一次回调）。
于是"下一段开始时的排入"**顶掉了上一段尚未执行的回调** —— 第一块思考记录的正文永远是空的。

**它为什么躲过了 1140 项单测**：
- 调度器自己的单测是过的一个 —— 调度器**本身没问题**；
- 单测里没有**真帧循环**，构造不出"两个段的排入落在同一帧"这个真实时序；
- 而我的 E2E 一开始只断言了 `toHaveCount(2)` —— **块数是对的**，所以照样过。

→ 抓到它的方式：E2E 里让夹具发**两段**思维链，并断言第二段的内容与顺序。

### 缺陷 3：跨作用域调用（静态门禁抓到）

`mountThinkSegment` 被写在 `openPanel` 内部，却在模块级的 `restoreStreamingUI` 里调用
→ **流式中重开面板必 `ReferenceError`**。

**它为什么躲过前两层**：
- 接线门禁是**源码正则**：只看得到"有没有调用"，看不到"能不能调用"；
- `node --check` 只做语法检查，不做作用域解析（这在 JS 里要运行到那一行才报）；
- **E2E 也从没在流式中重开过面板** —— 那一条分支压根没被执行。

→ 抓到它的方式：写了个**静态作用域门禁**（[`tests/panel-scope.test.mjs`](../tests/panel-scope.test.mjs)）
判定"模块级函数不得调用定义在更深层的函数"，**并注入该缺陷验证它确实会报错**。

### 三条结论

1. **数量与顺序是两个性质** —— 只断言"有几块"会漏掉"顺序全错"。
2. **"一次就过"要先怀疑有没有真的跑到** —— 缺陷 3 所在的分支从没被执行过。
3. **没有哪一层能覆盖全部**：
   - 需求层缺陷 → 读代码 + grep；
   - 真环境时序缺陷 → **E2E**；
   - "某分支从没执行"这类结构缺陷 → **静态门禁**。

## 九、把 E2E 用来沉淀「能力」：三层分工

前面几节讲的是"怎么测一个功能"。这一节讲**怎么用 E2E 沉淀一类能力**（例如"站内检索"、"点单"、"UI 美化"、"debug"）。

### 9.1 三层，缺一不可

| 层 | 做什么 | 靠什么验证 | 进 CI | 位置 |
| --- | --- | --- | --- | --- |
| **① 能力验收** | 能力剧本 + 代表页面 + 端到端用例 | 真浏览器 E2E，断言**页面真的到了目标状态** | ✅ | `tests/e2e/`、`tests/e2e/fixtures/` |
| **② 技能契约** | 技能声明的工具必须**覆盖**剧本实际用到的工具 | 纯静态机检 | ✅ | `tests/skill-playbook-contract.test.mjs` |
| **③ 技能有效性** | 同一批剧本，让**真模型自己决定**用哪些工具 | 真 API，看完成率与工具轨迹 | ❌ **按需手动** | `tests/e2e-eval/`、`scripts/eval-real-model.mjs` |

### 9.2 为什么必须分成三层（最容易搞错的一点）

**E2E 里的"模型"是脚本。** 夹具按 `userText` 返回**写死的**工具调用序列。
所以：

- E2E 能证明：**这套能力成立**（工具够用、链路通、页面真被改对了）；
- E2E **不能**证明：**这段技能文案对真模型有用**——因为决定是脚本做的，不是模型做的。

把这两件事混起来，就会得到"测试全绿但真模型还是不会用"的假信心。
**分开之后这个做法反而更值钱**：②让技能与能力不脱节，③才回答文案问题。

### 9.3 能力剧本（playbook）是什么

`tests/e2e/fixtures/playbooks.mjs` 是**纯数据模块**（零副作用，夹具与单测都能 import）：

```js
'site-search': {
  trigger: '站内搜',                                  // 夹具据此选剧本
  tools: ['get_page_snapshot','type_text','click_element','inspect_element'],  // ← 契约锚点
  success: '搜索框被填入查询词、结果列表已渲染、且工具结果里能看到真实条目的标题与价格',
  eval: { url, instruction, pageChecks, mustSeeInToolResults },  // 第三层用
}
```

`tools` 是关键：它是"**真正做到这件事实际需要哪几个工具**"，由 E2E 验证；
技能的 `x.tools` 是"教模型用哪几个"。**②断言前者 ⊆ 后者**。

### 9.4 断言要分两处，缺一不可

以站内检索为例：

1. **页面状态** —— 搜索框真被填了、结果真渲染了、真点了搜索按钮；
2. **模型收到了什么** —— 从夹具记录的请求里读**工具结果**。

第 2 条是这套做法的核心，因为**脚本化 E2E 里"最终答复写了什么"证明不了任何事**（那句话是脚本写的）。
能证明的是**数据到底有没有交到模型手上**。夹具因此导出 `getLlmRequests()` / `lastToolResultsText()`。

### 9.5 脚本化剧本的两个固有弱点（知道才能正确解读红灯）

1. **某一步失败，剧本会继续往下走**（脚本不会看错误调整）。
   所以**页面状态断言是唯一的兜底** —— 它才是抓住"填框失败"的那一条。
2. **它只走一条路径**。真模型可能绕远路但做成了，或用别的工具做成了 —— 那在剧本里根本表达不出来。

### 9.6 真模型 eval 的纪律

- **不进 CI**：花钱 + 非确定。随机红灯的唯一后果是大家开始无视红灯；
- **不追绿**：一次没过不等于坏。要看**趋势**与**失败时的工具轨迹**；
- **失败先看轨迹再改文案**：模型可能"绕远路但做成了"（文案不够省），
  也可能"压根没找到页面能力"（能力或提示问题）—— 这两者修法完全不同；
- **同一套夹具与判据**，只换"谁在做决定"。否则一旦表现不同，无法归因。

跑法：

```bash
RECALLFLOW_EVAL_API_KEY=sk-xxx node scripts/eval-real-model.mjs
```

### 9.6.1 首次实跑踩到的 4 个 harness 缺陷（都会让结论变成噪声）

这一层的代码**跑起来之前不算存在**。首次实跑时，harness 自己有 4 处错，
每一处都能产出"看起来像结论"的垃圾：

| 缺陷 | 症状 | 为什么危险 |
| --- | --- | --- |
| `waitForRunToFinish` 查的选择器 `.cmd-stop` **根本不存在**（真名是 `.stop-btn`） | "跑完了"恒为真 | **任务还没开始就判分**；用例会"通过"，但通过的原因与能力无关 |
| 只等"停止按钮不可见"就算跑完 | 同上 | 它在跑之前本来就是隐藏的 —— 必须**先等出现（确认开跑）再等消失（确认结束）** |
| 工具轨迹按请求累计、未去重 | 4 次调用报成 10 次（美化那轮 15 报成 113） | 让模型看起来远比实际浪费，而"看轨迹判断绕没绕路"正是这一层的核心用途 |
| 未处理 `alwaysRequireApproval` 的工具 | 整轮卡到超时 | `run_javascript` / `run_userscript` / `install_userscript` **任何审批策略都不放行**，真模型会选它们；必须自动批准并记下次数 |

另外补了 `printToolResults()`：**只看"调用了什么"判断不了失败原因** ——
工具可能返回错误（选择器没命中、定位失败、参数非法），而轨迹上完全看不出来。

**教训**：评测工具本身也需要"先跑一次看看它是不是在骗我"。
这一层刻意不进 CI，所以它没有任何自动化保障 —— 它自己就是那个"没被写下来的场景"。

### 9.6.2 首次实跑的能力结论

| 剧本 | 修复前 | 修复后 |
| --- | --- | --- |
| 站内检索 | ✓ | ✓ |
| 点单 / 表单 | ✓ | ✓ |
| UI 美化 | **✗（漏容器宽度）** | ✓ |
| 排查 / debug | ✓ | ✓ |

美化那一项的价值最大：**脚本化 E2E 是通过的**（剧本是我按已知答案写的），
而真模型只把字号/行高/对比度改对、**完全没碰宽容器** —— 页面"看起来好了一点"，
用户仍要左右拖动才能读完一行。**这正是"脚本下能过"与"真模型能不能用"的差别**，
也是这一层存在的全部理由。

修法不是改测试，而是**改技能文案**：补出编号步骤清单，把"改行宽 / 修横向溢出"单列成一步，
并写明判据是**横向滚动消失**而不是"我改过样式了"。
### 9.7 本仓库的四条实例（四类能力的完整形状）

`site-search`（检索）、`checkout-form`（点单 / 表单）、`readability-fix`（UI 美化）、
`debug-console-error`（排查）是这套设计的四个完整实例。
每新增一类能力，就是沿着同一条路径加一组文件：

```text
tests/e2e/fixtures/playbooks.mjs          剧本：trigger / tools（契约锚点）/ success / eval 判据
tests/e2e/fixtures/server.mjs             代表页面 + 脚本化剧本 + 请求记录
tests/e2e/golden.spec.mjs                 端到端用例（页面状态 + 模型收到了什么）
lib/assistant/skill-defs.js               技能（x.playbook 指向剧本、x.tools 覆盖剧本工具）
tests/skill-playbook-contract.test.mjs   ②契约门禁（自动覆盖新剧本，无需改测试）
tests/e2e-eval/real-model.eval.mjs        ③真模型 eval（自动覆盖带 eval 声明的剧本）
```

**关键在"难点"要真的造进代表页面**，否则用例只是走过场。四类各自的难点与取证方式：

| 能力类 | 真正的难点（代表页面必须造出来） | 取证方式（断言"模型收到了什么"） |
| --- | --- | --- |
| 站内检索 | 结果**点击后异步渲染**（工具必须等静定）＋ **混入广告**（检索与去广告是两种判断） | 工具结果里能看到真实条目的标题与价格 |
| 点单 / 表单 | **步骤有依赖**（缺项就不成交）＋ **勾选是承重件** ＋ 四种控件走四类工具 | 页面真正收到的订单数据（`window.__order`） |
| UI 美化 | **"达标"可以靠作弊**：隐藏正文或删内容，指标立刻合格 | 计算样式 **＋ 内容没少 / 仍可见** |
| 排查 / debug | **症状与原因不在同一处**，且错误只在交互后才产生 | **浏览器生成的**报错文案（不是模型的转述） |

四类的**共性**可以概括成一句话：**别用界面上的成功态当证据。**
检索要看数据到没到手，点单要看业务真的成交，美化要看内容没被牺牲，排查要看真实报错文案。

**一次只做一类**，每类的代表页面都要单独设计；一起上会变成几份半成品。

### 9.8 ⚠ 本轮真实收获：`firstTarget` 丢定位符

做站内检索时，剧本第 2 轮 `type_text({role:'textbox', name:'站内搜索'})` 返回
**「未找到可输入的目标元素」**。查下去发现：

- `type_text` 的 schema **声明了** role / name / testid / index / text 五个定位参数；
- 而页面命令走 `firstTarget(params, false)`，那个函数**只转发 ref 与 selector**，五个全丢；
- 于是"按说明填输入框"永远失败，报错还**读起来像"页面上没有这个输入框"**；
- 同一个页面里 `click_element` 能按语义定位、`type_text` 不能 —— 因为前者直接传 `findElementsFor(params)`。

**这类"承诺了却做不到"的缺陷，单看技能或单看工具名都发现不了**，
只有把技能声明的工具与"实际能做成什么"对照（第②层）才会暴露。
已修并加两道门禁：`tests/locator-param-forwarding.test.mjs`（静态）+ 「站内检索」E2E（行为）。

### 9.9 类过程中暴露的两个能力缺口（都是"补能力"而不是"改测试"）

做这四类时各暴露了一个**工具层**的问题，都不是测试写错：

1. **`type_text` 的 schema 承诺了 5 个定位参数，实现只转发 2 个**（详见 9.8）。
   填输入框按说明写永远失败，报错还读起来像"页面没有这个输入框"。
2. **改完样式无法自证**：`annotate({op:"style"})` 只回一句「已修改 N 个元素」，
   而当时唯一的取证路径 `run_javascript` 有两个硬伤 ——
   元数据是 `alwaysRequireApproval`（**任何策略都拦不住地打断用户**），
   且它经 eval 执行，而 **MV3 扩展自身的 CSP 不允许 eval**（与页面无关），
   所以**没有 CDP 就直接失败**。
   已补只读的 `inspect_element({op:"styles"})`（复用原本只给 MCP 侧 `verify_change` 用的
   `readElementState`，**工具数不变**）。

两个缺口的**共同形状**：schema 或文档承诺了一件事，实现做不到，而症状看起来像"页面/环境的问题"。
这也是第②层（技能契约）存在的理由 —— 它把"技能声明的工具"与"实际能做到什么"对起来看。
