# 真实站点验收清单（T1 未自动化部分）

> 这些页面需要登录态或稳定的测试账号，不能放进 CI。目标不是“页面能打开”，
> 而是验证 **custom element / ProseMirror / 内部滚动容器 / 草稿保存** 在真实 DOM 上的成色。
> 小红书只允许保存草稿，**绝不自动发布**；建议使用测试号。

## 小红书创作服务平台

准备：

- 手动登录一次，用 Playwright `storageState` 保存登录态到本地（不要提交仓库）。
- 只进入“发布笔记 / 草稿”页面，不点击发布。

检查顺序：

1. `get_page_snapshot`：应出现 `capabilities.customElements` 或 `capabilities.editables`
   （至少能识别发布按钮/编辑器），而不是只有一条空正文。
2. 找发布按钮：优先 `inspect_element({op:"query", text:"发布"})` 或
   `inspect_element({op:"query", role:"button", name:"发布"})`；确认返回 ref/rect。
3. 编辑器：确认 `capabilities.editables` 的样本类型是 `prosemirror`/`contenteditable`，
   用 `type_text` 写入两行文本，并检查回读的实际值含换行。
4. 内部滚动：若页面有固定高度容器，用
   `scroll_page({selector:"…", y:600})`，确认返回的 `scrollTop` 真的变化。
5. 保存草稿后读回标题/正文；只断言“草稿箱或编辑器里出现了内容”，不断言发布成功。

失败归因：

- `query` 无命中：先看快照 `capabilities` 是否识别到 custom element；
  若识别到但 query 不命中，记录 tag/选择器，补 query 的候选策略。
- `type_text` 回读不一致：记录编辑器类型与 `firstDifference`，不要用
  `run_javascript` 直接改 DOM 掩盖问题。

## 电商详情页（SKU / shadow DOM）

准备：选一个公开商品详情页，不需要登录。

检查顺序：

1. `get_page_snapshot` 看是否存在多规格控件；确认 `inspect_element({op:"query"})`
   能按 role+name 或 testid 找到规格按钮。
2. 逐个选择规格，`inspect_element({op:"text"})` 或 `get_attribute` 读回价格/库存变化；
   不要只以“点击成功”作为结论。
3. 如果规格在 shadow root 内，确认 `shadowDepth` 与 ref 可用；必要时用
   `get_ax_snapshot` 作为无 DOM 的降级路径。
4. 任何“加入购物车/提交”动作都只做可撤销的测试操作，结束后不提交真实订单。

## 登录 / 权限墙

准备：未登录的浏览器配置，或使用一个权限不足的测试账号。不要用真实主账号做越权测试。

检查顺序：

1. 打开一个需要登录的业务页并触发操作；工具结果应出现
   `操作被登录拦截` 或 `操作被权限限制`。
2. 面板应出现 `.auth-challenge` 提示条，链接必须来自页面真实登录入口；
   点击后应打开登录页，而不是模型猜测的地址。
3. 模型收到的 tool 结果必须包含同一个登录链接，以及“等待用户登录、不要反复点击/切换标签页”。
4. 在另一个已打开同一会话的标签页重复检查：提示条与登录链接应同步出现。

失败归因：

- 页面到了 `/login` 但没有提示：记录动作前后 URL，检查是否被站点前端路由吞掉。
- 提示误报：记录页面标题/正文里的“登录”字样与链接，区分教程文案和真实登录墙。
- 链接打不开：记录页面原始 href；不要用 `origin + '/login'` 的兜底结果替代真实入口。

## 标签页克制

检查顺序：

1. 让 Agent 在两个已打开标签页之间读取信息；同一 `tabId` 再次
   `switch_tab` 应返回 no-op。
2. 记录真实前台切换次数；达到 6 次后，后续 `switch_tab` 应被拒绝，
   模型应留在当前页或改用 `fetch_webpage`。
3. 复用已在前台的 URL 时不应再次调用 `update(active:true)`；
   用户视角不应出现无意义的标签页闪动。
4. `open_tab` 在切换预算耗尽后可以后台绑定目标页，但不应再抢前台；
   面板也不应显示“已切换标签页”。

## 记录格式

每条真实站点结果记录：

```text
站点 / URL：
登录态：无 / storageState（不入库）
任务：
工具轨迹（去重）：
页面判据：通过 / 失败（贴工具结果原文）
失败归因：定位器 / 时序 / 登录态 / 工具能力
```
