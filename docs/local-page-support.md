# 本地网页（file://）支持与「导出零痕迹」

> 两件事同一条链路：**能操作本地页**，且**操作完不该留在用户保存的文件里**。
> 本文写清边界与验收方式，避免后来者把"支持本地页"理解成"允许 agent 读磁盘"。

## 1. 能做什么

| 能力 | 本地页（`file://`） | 说明 |
| --- | --- | --- |
| 读正文 / 快照 / 可访问性树 | ✅ | 与普通网页同一条链路 |
| 点击 / 输入 / 选择 / 滚动 / 执行页面命令 | ✅ | 同上 |
| 划词提问、面板、悬浮球 | ✅ | **与普通网页一致，打开就有悬浮球** |
| 收录到知识库 | ✅ | URL 用 `file:///...` 原样保存 |
| 站点记忆 / 宏 / 站点信任 | ✅ | 站点键按**目录**归组，见 §5 |
| `open_tab` 主动打开本地路径 | ❌ 有意拒绝 | 见 §2 |
| `fetch_webpage` 抓本地文件 | ❌ 有意拒绝 | 同 §2 |
| 外部 AI（MCP `browser_read`）读本地文件 | ❌ | 桥接仍只收 http(s) |

## 2. 为什么不允许 agent 自己打开本地文件

`open_tab('file:///C:/Users/…')` + 读正文，等于把"逐路径探测本机磁盘"变成一个工具调用。
所以能力边界是这样切的：

- **用户自己打开的本地标签页**：可读可点 —— 那是用户主动交出来的上下文；
- **agent 主动发起的 file:// 请求**：拒绝，并给出替代路径（让用户自己打开后再读）。

判定落在 `lib/shared/utils.js` 的两个函数上，语义**不重叠**：

- `isOperableUrl(u)`：**用户此刻看着的页面**能不能注入 UI / 被读（http、https、file）；
- `open_tab` / `fetch_webpage` 里的 `/^https?:\/\//`：**agent 能不能主动去拿一个新页面**。

## 3. 入口不做取舍：本地页也有悬浮球

本地页与普通网页在 UI 上**完全一致** —— 打开就挂悬浮球，划词就出气泡，`Alt+Shift+R` 开面板。
曾经试过"本地页不常驻 UI"来保证保存干净，但那是拿最直接的入口去换一个本可以在别处解决的问题：
用户打开自己那份 HTML，第一眼发现助手不见了，只会认为"本地页不支持"。

所以"保存不留痕"改由两件事承担，**都不依赖牺牲入口**：

1. **导出那一刻把宿主摘出文档**（§4，Ctrl+S / 打印）；
2. **图标只存在于 shadow root 里** —— 页面自己序列化 DOM（`outerHTML` 一类）根本取不到 shadow 内容，
   最多留下一个空壳 `<div id="__kb-ai-host">`；离线副本里不会出现点不动的 RecallFlow 图标。

## 4. 三条导出路径分别怎么处理

实现见 `lib/page/save-clean.js`（守卫）与 `lib/page/panel-css.js`（打印样式）。

| 路径 | 漏的形态 | 处理 |
| --- | --- | --- |
| 浏览器「另存为」Ctrl+S | 序列化 light DOM：漏的是宿主空壳（shadow 内容不会被序列化） | 捕获阶段把宿主**移进 DocumentFragment**（不是 `display:none`），焦点回到页面即按原位插回 |
| 打印 / 导出 PDF | 走渲染，shadow 里的 FAB 会印出来 | shadow 内 `@media print { :host { display:none } }` + `beforeprint` 摘除（双保险） |
| 页面自己保存 | 无法拦截时机 | 图标在 shadow 里，序列化取不到；产物最多留一个空壳宿主 div，**没有图标** |

**为什么不能只靠隐藏**：`display:none` 的节点仍在文档里，另存出来的 HTML 照样带着它。
这条区别就是"隐藏了却还是被保存下来"的由来。

**恢复时机为什么不是固定定时器**：原生保存对话框是异步的，用户可能挑十几秒目录，而 Chromium
是在对话框关闭**之后**才序列化 —— 定时器太短会把宿主提前挂回去，于是又漏。所以按"人回到页面"
的事件恢复（`focus` / `visibilitychange` / 真实交互 + 800ms 宽限），另有 60s 兜底上限防 UI 永久消失。

守卫挂起期间，`ensureHost()` 与 1 秒保活看门狗都会停手（`uiSuspended`），
否则它们会在序列化窗口里把宿主重建出来。

## 5. 站点键：本地页按目录归组

`new URL('file:///C:/a.html').origin` 是字符串 `'null'`。直接拿它当键，会让
**所有本地文件共用一个站点**：A 文件里学到的选择器污染 B 文件，`trust_site` 从"信任一个目录"
悄悄变成"信任整块磁盘"。

所以统一走 `siteKeyOf(u)`：http(s) 用 origin，file 用**所在目录**（`file:///C:/docs/`）。
用在 `site-memory.js`、`macro-store.js`、`permission-tools.js`、`approval-policy.js`。

## 6. 用户要开的一个开关

`manifest.json` 里写 `file:///*` 只是申请。用户还必须在
`chrome://extensions` / `edge://extensions` → 本扩展 → 详情 → 打开**「允许访问文件网址」**，
否则内容脚本**静默不注入**：没有悬浮球、快捷键没反应、popup 也收录不了。

所以 popup 会先问一句 `chrome.extension.isAllowedFileSchemeAccess()`，没开就把原因写在
"当前页面无法收录"那一栏里（"请在扩展详情里打开「允许访问文件网址」"），而不是笼统说页面不支持。

## 7. 验收

```bash
npm run test:unit        # 含 tests/local-page-url  / local-page-manifest / save-clean
npm test                 # 全量门禁（含 content.js 新鲜度与体积预算）
```

手工验收（三步，缺一步都不算过）：

1. 打开任意本地 HTML → **应看到悬浮球**（与普通网页一致），点开能发指令、能点到页面元素；
2. 悬浮球在、面板开着时按 `Ctrl+S` 另存为 → 打开产物搜 `__kb-ai-host` / `recallflow` / `chrome-extension://`，应为 0 命中；
3. 面板开着时打印为 PDF → 纸面上不应出现悬浮球与面板。

## 8. 残余边界（写清楚，别当成已完成）

- 页面在"保存"时若做的是**截图**（而非序列化 DOM），浏览器层面无法屏蔽 ——
  这属于"把页面当图片存"，扩展无法干预；
- 页面自己用 `outerHTML` 一类序列化保存时，产物里可能留下一个**空壳** `<div id="__kb-ai-host">`，
  但不含图标（图标在 shadow root 内，序列化取不到 shadow）；
- 打印守卫依赖 `beforeprint` 或 `@media print` 生效；两者同时失效属于浏览器异常，未做额外兜底；
- `open_tab` 对 file:// 的拒绝是产品决策，测试 `tests/tab-tools.test.mjs` 把它钉成断言 ——
  要改就得同时改产品口径，而不是顺手放过。
