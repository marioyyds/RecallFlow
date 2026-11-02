# RecallFlow 视觉规范 · 纸与墨（Paper & Ink）

> 这份文档是 UI 改版的唯一契约。任何页面样式都要能在这里找到出处；
> 找不到出处，要么改这里，要么别改界面。
>
> 目标：把「通用 SaaS / AI 助手」的观感换成「一个安静的、纸质的阅读与整理工具」。

## 1. 为什么长这样

常见的「AI 味」不是某个颜色，而是一组默认值的叠加：

| 默认做法 | 为什么显假 | 这里的做法 |
| --- | --- | --- |
| 品牌蓝 `#4a90d9` + 浅灰底 `#f0f2f5` | 任何 SaaS 模板的出厂色，和产品没关系 | 暖纸 `#f6f3ec` + 近白纸面 `#fffdf8` + 墨字 `#211e19` |
| 一切皆药丸 + 12/14px 大圆角 | 圆角代替了层级，所有东西一样重 | 圆角 3/5/7/9/12；胶囊只留给状态徽标 |
| 卡片都带投影 | 静态内容不该"浮"起来 | 静态面 1px 发丝线；投影只给弹层 |
| emoji 当图标 | 跨平台字形不同、颜色失控、像聊天玩具 | 统一 1.6px 描边内联 SVG（`icons.svg`） |
| 11–15px、字重 500/600 混用 | 没有真正的层级，只能靠颜色区分 | 10.5 / 11.5 / 12.5 / 14 / 15 / 17 / 20 / 24 的固定字级 |
| 强调色铺满（按钮、tab、徽标、链接） | 没有重点＝全是重点 | 朱砂 `#a03a22` 只给：主按钮、当前项指示线、链接 |
| hover 上浮 + `scale(.98)` | 廉价动效，且会让列表抖动 | 只过渡颜色 / 边框 / 底色，140–160ms |
| 大 emoji 空状态 | 空洞且不可控 | 空状态＝一句说明 + 一个下一步动作 |

## 2. 令牌（全部定义在 `base.css`，页面 CSS 只用 `var()`）

### 颜色

| 变量 | 浅色 | 暗色 | 用途 |
| --- | --- | --- | --- |
| `--bg` | `#f6f3ec` | `#191713` | 页面底色（暖纸） |
| `--card` | `#fffdf8` | `#211e18` | 纸面：卡片、输入框、下拉 |
| `--note-bg` | `#f1ebdf` | `#2a2620` | 下沉面：备注块、徽标底、hover 底 |
| `--text` | `#211e19` | `#ede7db` | 正文 / 标题（墨） |
| `--text-sub` | `#575047` | `#b4ab9c` | 次级文字（≥7:1） |
| `--text-faint` | `#6f6659` | `#8e8577` | 元信息 / 占位（≥4.9:1） |
| `--border` | `#e1d8c8` | `#37322a` | 发丝分隔线 |
| `--border-strong` | `#ccc0ac` | `#4a443a` | 控件描边、滚动条 |
| `--primary` | `#a03a22` | `#e08a63` | 朱砂：主操作 / 当前 / 链接 |
| `--primary-hover` | `#8a3220` | `#eda07a` | 主操作 hover |
| `--primary-soft` | `rgba(160,58,34,.09)` | `rgba(224,138,99,.14)` | 选中底、图标按钮 hover |
| `--primary-line` | `rgba(160,58,34,.28)` | `rgba(224,138,99,.34)` | 选中项描边 |
| `--danger` / `--danger-soft` | `#a32c2c` / 9% | `#e08a80` / 14% | 删除、错误 |
| `--success` / `--success-soft` | `#2e6a4e` / 10% | `#7fc39d` / 14% | 成功、已启用 |
| `--warn` / `--warn-soft` / `--warn-line` | `#8a5a00` / `#fff6e2` / `#e6c98f` | `#f0c97a` / `#342c1d` / `#6a5526` | 审批、注意 |
| `--star-on` / `--star-level` | `#b4801f` | 同 `--gold-text` | 星级（图形，非文字） |

### 字体与字级

```css
--font-sans:    ui-sans-serif, -apple-system, "Segoe UI", "PingFang SC",
                "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif;
--font-display: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Songti SC", serif;
--font-mono:    ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
```

- `--font-display` **只**用于：品牌字、大号数字/统计、拉丁文小标题（`kicker`）。中文标题永远走 `--font-sans`。
- 字级：`--fs-micro 10.5` / `--fs-xs 11.5` / `--fs-sm 12.5` / `--fs-base 14` / `--fs-md 15` / `--fs-lg 17` / `--fs-xl 20` / `--fs-2xl 24`。
- 标题：`font-weight: 650`、`letter-spacing: -0.01em`；14px 以上的中文不要加 `letter-spacing`。
- 小标签：`10.5px` + `letter-spacing: .09em` + 小写转大写（仅拉丁文），颜色 `--text-faint`。
- 数字：列表里的计数、时间一律 `font-variant-numeric: tabular-nums`（`.num` / `.time` / `.count`）。

### 尺度

- 圆角：`--radius-xs 3`（tag）/ `--radius-sm 5`（mini 按钮、筛选块）/ `--radius-md 7`（按钮、输入框）/ `--radius-lg 9`（列表条目）/ `--radius-xl 12`（卡片）/ `--radius-pill`（仅状态徽标、计数）。
- 间距：`--space-1..6` = 4/8/12/16/20/24，`--space-8` = 32。
- 页面宽度：`860px` 内容栏（options / manager 断言要求），`16px` 横向 gutter。
- 控件高度三档：`32`（`.btn`）/ `40`（`.btn-lg`，主操作与表单提交）/ `26`（`.mini`）。菜单项、tab 32–34。

## 3. 组件规范

### 3.1 顶栏 + 模块导航（`.app-topbar` / `.app-header` / `.module-nav`）

- 吸顶、通栏、底色 `--bg`、底部一条 `--border` 发丝线。**不是**悬浮圆角卡片。
- 品牌：28px 墨色方标（`--font-display` 的 `R`）+ 15px 标题 + 10.5px 页面说明。
- 模块导航：文字 tab，当前项底部 2px 朱砂线（`.module-nav-item.active::after` scaleX(1)），其余透明；hover 只变字色。
- 右侧工具区：`.btn .btn-secondary` 或 `.icon-btn`，不要药丸。

### 3.2 按钮

| 类 | 外观 | 用在哪 |
| --- | --- | --- |
| `.btn-primary` | 朱砂实心、纸色字 | 每屏**一个**主动作（新建 / 保存 / 搜索） |
| `.btn-secondary` | 纸面 + `--border-strong` 描边 | 次动作（导出、检查更新） |
| `.btn-ghost` | 无边无底，hover 浅朱砂底 | 第三档（更多、取消） |
| `.mini` | 26px 小按钮 | 列表条目内、确认框 |
| `.icon-btn` | 30px 方形，hover 才出底 | 图标按钮 |

### 3.3 搜索与筛选

- 搜索框统一 `.search-box`：方角 7px、`--border-strong` 描边、左内嵌 `i-search`、focus 时描边转朱砂 + 3px `--primary-soft` 光晕。
- 筛选 `一` 改成一排**文字标签 + 等宽数字计数**（`.filter-chip`，选中＝浅朱砂底 + 朱砂字 + 浅朱砂描边），不再是一排实心药丸。
- 已选条件（`.active-filter-chip`）：方角浅朱砂小片，可点 × 移除。

### 3.4 列表条目

- `.item`：纸面 + `--border` 发丝边 + `--radius-lg`，**无投影**；hover 只把边加深到 `--border-strong`。
- 标题 15px/650；元信息 11.5px `--text-faint`；备注块走 `--note-bg` + 5px 圆角。
- 类型徽标保留胶囊（10.5px，`--note-bg` 底）；标签 `.tag-chip` 改方角 3px、透明底 + 发丝边。
- 批量/操作按钮走 `.mini`，默认 `opacity: .0` 只在 hover/focus-within 出现（列表才安静），触屏用 `@media (hover: none)` 常显。

### 3.5 空状态

```html
<div class="empty">
  <svg class="empty-ico" aria-hidden="true"><use href="icons.svg#i-book"/></svg>
  <p>知识库还是空的</p>
  <p class="empty-hint">点「新建笔记」，或在任意网页上按 Alt+Shift+S</p>
  <button class="btn btn-primary">新建笔记</button>
</div>
```

- 一句标题 + 一句怎么开始 + 一个动作。图标 26px、`--border-strong` 色、描边风格。
- 禁止：大 emoji、居中大块留白里只有一行灰字。

### 3.6 表单与设置

- `.field`：label 12.5px/600 `--text-sub`，控件 36–40px 高，说明 11.5px `--text-faint`。
- 输入框：纸面、`--border-strong`、7px 圆角，focus 时朱砂描边 + 浅光晕。
- 开关：24×14 轨道、10px 圆点；开启＝朱砂，关闭＝`--border-strong`；`focus-visible` 有 2px 环。
- 分组标题：11px kicker + 上分隔线；组与组之间 `--space-6`。
- 危险操作单独一组，放在页面最后，红字按钮而不是红底大块。

### 3.7 弹层 / 菜单 / 确认框

- 只有这一层允许投影：`--shadow-float`。
- 圆角 `--radius-lg`/`--radius-xl`，1px `--border-strong`，背景 `--card`。
- 遮罩 `rgba(20,18,14,.5)`。
- 确认框：标题 15px/650、正文 14px、按钮右对齐（取消 `.mini` + 确认 `.mini.primary`/`.mini.danger`）。

### 3.8 Toast

- 墨底纸字、7px 圆角、`--shadow-float`，最多 420px 宽，单行优先。

## 4. 图标

- 唯一来源：仓库根 `icons.svg`（`<symbol id="i-*">`），用
  `<svg class="icon" aria-hidden="true"><use href="icons.svg#i-search"/></svg>`。
- 现有：search plus minus close more chevron-down/right/up arrow-right/up-right/up send book key eye eye-off cpu puzzle trash edit check star globe shield copy download upload filter sort refresh settings panel link clock doc code moon sun info alert stop folder list grid external spark history bell pin。
- 规则：24×24 视框、1.6px 描边、`stroke: currentColor`（由 `.icon` 给）；同一行图标与文字基线对齐（`vertical-align:-3px`）。
- 内联注入的面板（Shadow DOM）**不引雪碧**：`content.js` 只剩一两 KB 余量，塞不下 45 个 symbol。面板里的图标全部用 CSS 绘制的小标记 —— 叉号（`.p-head .close::before` 等，两条 1.4px 描边转 45°）、thinking 折叠的 chevron（`.think-caret::before`）、执行计划的三态点（`.plan-mark`）、主题的半明半暗圆（`.p-head .theme::before`）、需要说明的状态一律用中文文字标签。以后给面板加图标也走这条路，别为了一个图形去动体积棘轮。
- **禁止**：emoji 当图标；`▸ ▾ ⌕ ↻ ⋯ ×` 这类字形当图标（字形因字体而异，且不能被 currentColor 正确控制）。

## 5. 动效与状态

- 时长 140–160ms，`--ease: cubic-bezier(.2,.7,.3,1)`；不做回弹、不做位移上浮（面板内的浮层除外）。
- 所有交互元素必须有 hover / focus-visible / disabled 三态；危险操作 hover 才变红。
- `prefers-reduced-motion` 已在 `base.css` 全局关掉动画，页面不要绕过。
- 焦点环：2px `--focus-ring` + 2px offset；不要 `outline: none` 且无替代。

## 6. 布局

- 内容栏 860px，横向 gutter 16px；平板 768px 起收窄内边距，手机 375px 单列。
- 宽屏允许两栏（设置页 150px 侧栏 + 主栏），但侧栏必须是**导航**，不是又一张卡片。
- 列表与表单的最大行宽 70–80ch；长文本（笔记正文、markdown）单独限宽。
- 分页：底部一行左「共 N 条」右页码，页码是方角数字按钮，当前项墨底纸字（不是朱砂实心大圆）。

## 7. 门禁（改 UI 前必须知道）

- `npm test` = 全量门禁；UI 相关至少跑：
  `node --test tests/ui-optimization.test.mjs tests/entries-build.test.mjs tests/extension-pages.test.mjs tests/static-checks.test.mjs`
- 真实浏览器冒烟：`node scripts/verify-extension-pages.mjs`（断言五页关键节点存在）。
- 重建产物：`node scripts/build-entries.mjs`（页面入口）与 `node scripts/build-content.mjs`（内容脚本，改面板必跑）。
- 体积棘轮：`scripts/build-entries.mjs` 的 `ENTRY_BUDGETS`、`scripts/build-content.mjs` 的 `SIZE_BUDGET_BYTES`。超了要**在同一处上调并写原因**，不准绕过。
- 不许动的接线（测试逐条断言）：`options.html` 的 `#save-state` / `.settings-sidebar` / `#settings-behavior` / `#approval-preset`；`options.css` 的 `--settings-gutter`、`body{max-width:860px}`、`.actions{position:sticky}`、`.save-state.dirty`；`manager.css` 的 `.type-tabs{padding-inline:16px}` 及 620px 断点；`skills.html` 的 `#skill-search` / `#skill-kind-filters` / `#skill-category-filter`；`PANEL_CSS` 的 `.quick-prompts{flex-wrap:wrap}`、`.quick-prompt{white-space:normal;max-width:100%}`、`:host(:not(:defined))` 与 `@media print` 存档闸、`.fab` 直径与 `.fab.peek` 露出算术、resize 手柄规则。
- 每个页面的关键节点（冒烟脚本断言）：popup `#add-panel` `#list` `#search-shortcut`；options `#api-key` `#model` `.settings-sidebar`；manager `#type-tabs` `#list` `#kb-pagination`；skills `#skill-list` `#skill-search` `#new-skill-btn`；userscripts `#us-installed-list` `#us-search-input`。