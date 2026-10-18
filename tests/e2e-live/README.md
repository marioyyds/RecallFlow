# 真实站点实验室（T1）

> 复用 `tests/e2e/` 的 harness（真 Chromium + 装扩展 + 脚本化模型），但把夹具页换成**真实站点**。
> 它验证的是定位器 / 时序 / 登录态在真实 DOM 上的成色，不花真钱（模型决定是脚本化的）。
> 对应方案文档：`docs/testing-live-sites-plan.md` 的 T1。

## 为什么这个目录独立

- **不进 CI**：真实站点随时会改版，断言必碎；混进 `tests/e2e/*.spec.mjs` 会把黄金任务拖红。
- **默认不跑**：用环境变量 `E2E_LIVE=1` 显式打开，spec 里默认 `test.skip`。
- 登录态以后用 Playwright `storageState` 持久化（现在两个站点都免登录）。

## 怎么跑

```powershell
$env:E2E_LIVE='1'
node scripts/run-e2e-live.mjs
```

脚本化模型的 per-site 分派在 `tests/e2e/fixtures/server.mjs`（按 `sites.mjs` 的 trigger），
站点数据与判据在 `tests/e2e-live/sites.mjs`。

## 已跑通的站点（2026-10-17）

| 站点 | 验证什么 | 结论 |
| --- | --- | --- |
| 必应搜索 | 填框 → 回车搜索 → 等结果渲染 → 读回条目 | ✓ 定位器 `#sb_form_q` / `li.b_algo` 可用 |
| 维基百科调研 | 读词条标题/正文 → 沉淀进知识库 | ✓ `#firstHeading` / `#mw-content-text` 可用 |
| SauceDemo 登录+结算 | 真实登录表单 + 多步结算 | ✓ `data-test` 定位可用（JS 渲染的 SPA，要等控件挂上） |
| SauceDemo 加购助手 | 真实业务状态变化（购物车徽标） | ✓ |
| GitHub 检索 | 真实搜索结果列表 + 沉淀知识库 | ✓ `[data-testid="results-list"]` 可用 |
| MDN 长文标注 | 高亮 + 给 h1 加阴影 + 读回计算样式 | ✓ `h1` / `article` 可用 |
| 百度搜索 | 本地搜索引擎、DOM 不同 | ⚠ **默认跳过**：自动化常被重定向到安全验证页（见下） |
| arXiv 摘要 | 读论文摘要并沉淀 | ✓ `.abstract` 可用 |
| 有道词典 | 查单词释义 | ✓ `.trans-container` 可用 |
| httpbin 表单 | 填表单 + 提交 + 回显 JSON | ✓ `input[name]` / `form button` 可用 |
| PyPI 包信息 | 读包名与简介并沉淀 | ✓ `h1` / `.project-header__summary` 可用 |
| demoqa 文本框表单 | JS SPA 表单填写 + 提交 + 结果回显 | ✓ `#userName` / `#userEmail` / `#submit` / `#output` 可用 |

## 真实 DOM 上暴露的问题（就是这层存在的理由）

1. **维基百科的 `#firstHeading` 会被 JS 追加「[编辑]」**：标题判据不能用精确相等，
   要用 `startsWith('数据库索引')`（夹具页没有这个，所以夹具 E2E 永远发现不了）。
2. **必应结果容器判据要盯 `li.b_algo` 条目数**，而不是容器 innerText 长度——后者在
   页面导航/重定向的瞬间会被读到空，且真机里 `#b_results` 的 innerText 并非稳定信号。
3. **真实站点会重定向**：`page.evaluate` 可能撞上"执行上下文已销毁"，poll 的谓词必须
   `.catch(() => false)` 吃掉再重试。
4. **指令触发词会跨"剧本/站点"碰撞**：维基百科指令里若出现「知识库」（夹具剧本的触发词），
   脚本化分派会静默跑成 `knowledge-save-retrieve`。真实站点指令要避开夹具剧本触发词，
   或把更具体的分派块排在前面。
5. **百度会重定向自动化浏览器到安全验证页**：`#kw` 搜索框不存在、任务填不进去。
   `sites.mjs` 里标 `flaky: true`，默认跳过，`E2E_LIVE_FLAKY=1` 才跑（真实站点失败不追绿）。
6. **SPA 客户端导航会移除面板宿主**（GitHub Turbo 实测）：内容脚本不重新注入、
   模块级 `host` 引用仍指向已脱离的节点，FAB 永久消失。已修：`lib/page/chat.js` 增加
   低频保活轮询 `watchHostKeepalive()`，宿主脱离后自动重建；回归用例在
   `tests/e2e/golden.spec.mjs`（「SPA 导航移除宿主后自动重建」）。
   注：GitHub 点进仓库的场景仍暂时收敛为"读结果并沉淀"——点击后是否还会中断本轮任务
   （端口级而非 UI 级）待下一步复核。
7. **GitHub 仓库页"任务停在第一次快照"—— 已查明并修复（是夹具触发词碰撞，不是产品 bug）**：
   真实站点指令里的「Express 框架」命中了 server.mjs 里硬编码的场景 A 触发词「框架」
   （跨域 iframe 剧本，排在 live 分派之前），于是静默跑成夹具剧本、只做了一次快照就收尾。
   已改指令避免「框架」，并在 `tests/live-sites-contract.test.mjs` 补一条门禁：
   **真实站点指令不得混入 server.mjs 里硬编码的场景触发词**（动态解析 `userText.includes('…')`）。
8. **全页跳转会中断本轮 run —— 已修复**：端口断开不再自动 abort（整页刷新也会断开端口），
   停止改为面板显式发 `{type:'stop'}`，标签页关闭由 `tabs.onRemoved` 兜底。
   于是必应搜索提交、httpbin 表单提交这类整页导航后，任务会继续经 tab 执行（
   工具走 `chrome.tabs.sendMessage`，刷新后到达新内容脚本）。
   回归用例：`tests/e2e/golden.spec.mjs`「整页刷新后任务应继续跑完」。
   **新面板接管仍在跑的 run —— 已升级为不 abort**：新增 `RunChannel` 作为 run 的稳定输出口；
   旧页面 port 断开只 `detach`，新页面用 `reattach` 挂回同一个 run，先补发快照再继续实时事件。
   审批监听也走同一个 channel，刷新时正在等待的工具审批会在新面板恢复并继续。
   8 秒内没有 reattach 才回退到 abort + 同 `runId` 续跑（扩展更新/worker 回收）。
   回归断言用 `starts=1 / reattaches≥1 / aborts=0` 证明走的是接管而不是续跑，并覆盖
   “刷新前步骤 + 最终回复 + 用户消息不重复”和“审批等待中刷新后仍能批准”。

## 下一步

电商详情页（shadow DOM / SKU 规格）、小红书草稿（`storageState` 登录态 + 草稿模式）——
沿同一条路径往 `sites.mjs` 加数据、往 `server.mjs` 加 per-site 分派即可。
