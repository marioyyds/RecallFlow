// 面板（Shadow DOM）的样式表。
//
// 为什么单独成模块：它是纯字符串、无任何依赖，却是 chat.js 里最长的一段，
// 把样式与逻辑混在一个文件里会让「面板行为」极难通读。抽出来后 chat.js 只保留逻辑。
//
// 视觉语言见 docs/design-system.md（纸与墨）：暖纸底、墨字、发丝线分层、
// 朱砂只用主操作/当前/链接。图标：面板内不引雪碧（content.js 只剩 ~1.2KB 余量），
//   一律用 CSS 绘制的小标记（叉号 / chevron / 三态点 / 半明半暗圆）；页面侧用 icons.svg 雪碧。
//   emoji 与 ▸ ▾ × 这类字形禁用 —— 它们随字体跳宽度、跳基线，正是「AI 味」的来源。
// 面板在 Shadow DOM 里，拿不到页面 CSS 变量，所以令牌定义在 :host 上。

export const PANEL_CSS = `
    :host {
      /* 浅色令牌 */
      --p-bg: #fffdf8;
      --p-head: #f6f3ec;
      --p-note: #f1ebdf;
      --p-line: #e1d8c8;
      --p-line-strong: #ccc0ac;
      --p-text: #211e19;
      --p-text-sub: #575047;
      --p-text-faint: #6f6659;
      --p-accent: #a03a22;
      --p-accent-hover: #8a3220;
      --p-accent-soft: rgba(160, 58, 34, .09);
      --p-accent-line: rgba(160, 58, 34, .28);
      --p-danger: #a32c2c;
      --p-success: #2e6a4e;
      --p-warn: #8a5a00;
      --p-warn-bg: #fff6e2;
      --p-warn-line: #e6c98f;
      --p-code-bg: #f5efe3;
      --p-float: 0 18px 44px rgba(38, 30, 18, .18), 0 2px 6px rgba(38, 30, 18, .07);
      --p-font: ui-sans-serif, -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif;
      --p-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      --p-ease: cubic-bezier(.2, .7, .3, 1);
      --p-dur: .15s;
    }
    :host { all: initial; }
    /* 存档自毁闸 —— 别删这条。
       Edge/Chromium 的「另存为」会把 open shadow root 一起序列化成声明式 shadow DOM
       （已实测：保存出来的副本里能看到 .fab 与图标引用），所以"只要图标在 shadow 里就安全"是错的。
       宿主改用自定义元素 rf-ai-host：副本里没有我们的脚本，元素不会被升级，
       于是这条 :not(:defined) 命中，整块 UI 在存档里是 display:none —— 不依赖
       "能不能拦住保存动作"，也不需要偷偷把 DOM 摘掉。
       实测三组对照：div + 该规则 → 仍然显示；rf-ai-host 未定义 → 0×0 隐藏；
       rf-ai-host 已定义 → 52×52 正常显示。 */
    :host(:not(:defined)) { display: none !important; }
    * {
      box-sizing: border-box; margin: 0; padding: 0;
      font-family: var(--p-font);
    }
    /* 面板里的图标一律走内联雪碧（chat.ts 的 iconSprite()），这里只给尺寸与描边。 */
    .icon { width: 14px; height: 14px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
    .icon-sm { width: 12px; height: 12px; }
    .icon-lg { width: 16px; height: 16px; }
    .bubble {
      position: fixed; z-index: 2147483647;
      display: flex; align-items: center; gap: 6px;
      background: var(--p-text); color: var(--p-bg); border-radius: 6px;
      padding: 6px 11px; cursor: pointer; user-select: none;
      font-size: 12.5px; box-shadow: 0 6px 18px rgba(33, 30, 25, .28);
      transition: background var(--p-dur) var(--p-ease);
      animation: kb-pop .16s var(--p-ease);
    }
    @keyframes kb-pop { from { transform: scale(.94); opacity: 0; } to { transform: scale(1); opacity: 1; } }
    .bubble:hover { background: var(--p-accent); }
    .bubble .dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; opacity: .7; animation: kb-blink 1.4s infinite; }
    @keyframes kb-blink { 0%,100% { opacity: .7; } 50% { opacity: .2; } }
    .panel {
      position: fixed; z-index: 2147483647;
      width: 640px; height: auto; min-width: 280px; min-height: 320px;
      max-width: calc(100vw - 24px); max-height: calc(100vh - 24px);
      background: var(--p-bg); color: var(--p-text);
      border: 1px solid var(--p-line-strong); border-radius: 10px;
      box-shadow: var(--p-float);
      display: flex; flex-direction: column; overflow: hidden;
      animation: kb-pop .16s var(--p-ease);
      /* 左右边缘留给 resize 手柄的抓取宽度。
         手柄是绝对定位 + z-index:5，压在正文之上；而滚动条也贴在容器右边缘，
         两者会完全重叠 —— 结果就是滚动条点不动、也拖不动（mousedown 被 resize 抢走）。
         所以滚动容器必须按同样宽度右缩，让滚动条落在手柄左侧。
         取值同时被 .resize-handle.left/.right 与 .p-body 使用，避免两处各写一个数字后漂移。 */
      --rf-edge: 10px;
    }
    .panel.docked { max-height: calc(100vh - 24px); }
    @media (max-width: 640px) { .panel.docked { max-height: calc(100vh - 24px); } }
    /* 嵌入态（embedded）：面板不再是浮层，而是「嵌在页面里的一栏」——
       整列贴右缘、高度占满布局视口，宽度由 JS 按比例（panel-layout 的 PANEL_EMBEDDED_*）设置；
       页面正文同步右缩同样宽度，内容不会从面板底下穿过。
       位置（top/right/bottom）全部交给这段 CSS，JS 不写内联值（内联值会覆盖样式表）。
       ⚠ 必须排在 .panel.docked 之后：两者同为两段类名选择器，后者声明在前。 */
    .panel.embedded {
      top: 0; right: 0; bottom: 0;
      height: auto; max-height: none; max-width: none;
      border-radius: 0; border: 0;
      border-left: 1px solid var(--p-line);
      box-shadow: none;
      animation: none;
      transition: width .16s var(--p-ease);
    }
    /* 嵌入态只有左缘可以拉伸（宽度=分栏比例），高度恒占满整列，其余手柄没有意义。 */
    .panel.embedded .resize-handle { display: none; }
    /* 嵌入态唯一的缩放入口就是左缘：必须让它**看得见**。
       原来这里是一条 10px 宽的透明热区 —— 界面上没有任何提示，用户只会觉得
       「这个栏怎么调都不动」（反馈原话：对话窗太小、还不能调节）。
       现在常驻一条竖向抓手，hover / 拖动时变强调色。 */
    .panel.embedded .resize-handle.left { display: block; width: 12px; }
    .panel.embedded .resize-handle.left::after {
      display: block; content: '';
      left: 4px; top: 50%; right: auto; bottom: auto;
      transform: translateY(-50%);
      width: 3px; height: 40px; border: 0; border-radius: 999px;
      background: var(--p-line-strong); opacity: .9;
      transition: background var(--p-dur) var(--p-ease), opacity var(--p-dur) var(--p-ease);
    }
    .panel.embedded .resize-handle.left:hover::after,
    .panel.embedded .resize-handle.left:active::after { background: var(--p-accent); opacity: 1; }
    .resize-handle {
      position: absolute; right: 0; bottom: 0;
      width: 18px; height: 18px; cursor: nwse-resize;
      user-select: none; touch-action: none; z-index: 5;
    }
    .resize-handle.top-left { right:auto; bottom:auto; left:0; top:0; cursor:nwse-resize; }
    .resize-handle.top-left::after { right:auto; bottom:auto; left:4px; top:4px; border-right:0; border-bottom:0; border-left:1.5px solid var(--p-line-strong); border-top:1.5px solid var(--p-line-strong); border-radius:2px 0 0 0; }
    .resize-handle.top { left:18px; right:18px; top:0; bottom:auto; width:auto; height:10px; cursor:ns-resize; }
    .resize-handle.bottom { left:18px; right:18px; top:auto; bottom:0; width:auto; height:10px; cursor:ns-resize; }
    .resize-handle.left { left:0; top:18px; right:auto; bottom:18px; width:var(--rf-edge); height:auto; cursor:ew-resize; }
    .resize-handle.right { right:0; left:auto; top:18px; bottom:18px; width:var(--rf-edge); height:auto; cursor:ew-resize; }
    .resize-handle.top-right { left:auto; right:0; top:0; bottom:auto; cursor:nesw-resize; }
    .resize-handle.bottom-left { left:0; right:auto; top:auto; bottom:0; cursor:nesw-resize; }
    .resize-handle::after {
      content: ''; position: absolute; right: 4px; bottom: 4px;
      width: 9px; height: 9px;
      border-right: 1.5px solid var(--p-line-strong); border-bottom: 1.5px solid var(--p-line-strong);
      border-radius: 0 0 2px 0;
      transition: border-color var(--p-dur) var(--p-ease), opacity var(--p-dur) var(--p-ease);
      /* 抓握点必须常驻可见。早期版本是 opacity:0，而 hover 时又把边框改成
         transparent —— 等于从头到尾没有任何视觉提示，用户只能盲猜边缘能拖。
         这就是「整个窗口大小不好调节」的直接原因（手柄其实一直能拖）。 */
      opacity: .6;
    }
    .resize-handle:hover::after, .resize-handle:active::after { opacity: 1; border-color: var(--p-accent); }
    /* 平边手柄不画角落 L 形（L 会落在面板内侧，看着像噪点），
       改为 hover 时沿该边画一条强调线，明确告诉用户「这条边可以拖」。 */
    .resize-handle.top::after, .resize-handle.bottom::after,
    .resize-handle.left::after, .resize-handle.right::after { display: none; }
    .resize-handle.top::before, .resize-handle.bottom::before,
    .resize-handle.left::before, .resize-handle.right::before {
      content: ''; position: absolute; background: var(--p-accent); opacity: 0;
      transition: opacity var(--p-dur) var(--p-ease); border-radius: 2px;
    }
    .resize-handle.top::before { left: 24%; right: 24%; top: 2px; height: 2px; }
    .resize-handle.bottom::before { left: 24%; right: 24%; bottom: 2px; height: 2px; }
    .resize-handle.left::before { top: 24%; bottom: 24%; left: 2px; width: 2px; }
    .resize-handle.right::before { top: 24%; bottom: 24%; right: 2px; width: 2px; }
    .resize-handle:hover::before, .resize-handle:active::before { opacity: .9; }
    /* 深色令牌：面板是独立浮层，跟页面主题解耦，由 .dark 类切换 */
    .panel.dark {
      --p-bg: #191713;
      --p-head: #211e18;
      --p-note: #2a2620;
      --p-line: #37322a;
      --p-line-strong: #4a443a;
      --p-text: #ede7db;
      --p-text-sub: #b4ab9c;
      --p-text-faint: #8e8577;
      --p-accent: #e08a63;
      --p-accent-hover: #eda07a;
      --p-accent-soft: rgba(224, 138, 99, .14);
      --p-accent-line: rgba(224, 138, 99, .34);
      --p-danger: #e08a80;
      --p-success: #7fc39d;
      --p-warn: #f0c97a;
      --p-warn-bg: #2a2318;
      --p-warn-line: #6a5526;
      --p-code-bg: #14110d;
      --p-float: 0 20px 48px rgba(0, 0, 0, .55), 0 2px 8px rgba(0, 0, 0, .4);
    }
    .p-head {
      display: flex; align-items: center; gap: 8px;
      padding: 9px 12px;
      background: var(--p-head);
      border-bottom: 1px solid var(--p-line);
      cursor: grab;
    }
    .p-head:active { cursor: grabbing; }
    .p-head .logo { width: 18px; height: 18px; object-fit: contain; flex-shrink: 0; border-radius: 4px; }
    .p-head .title {
      font-size: 13px; font-weight: 650; letter-spacing: -.01em; color: var(--p-text);
      flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .p-head .usage {
      font-size: 10.5px; color: var(--p-text-faint); margin-left: auto; margin-right: 4px;
      white-space: nowrap; font-variant-numeric: tabular-nums;
    }
    .p-head .close {
      border: none; background: none; color: var(--p-text-faint); cursor: pointer;
      line-height: 1; padding: 0; border-radius: 4px; min-width: 28px; min-height: 28px;
      display: inline-flex; align-items: center; justify-content: center;
      transition: color var(--p-dur) var(--p-ease), background var(--p-dur) var(--p-ease);
    }
    .p-head .close:hover { color: var(--p-danger); background: var(--p-note); }
    /* 头部的次级小按钮（模式、交接码、会话、主题）：无边框文字按钮，
       hover 才出浅纸底 —— 三个药丸按钮并排正是「AI 面板」的典型长相。 */
    .p-head .mode-btn,
    .p-head .session-btn,
    .p-head .handoff,
    .p-head .theme {
      border: 1px solid transparent; background: none; color: var(--p-text-sub);
      font-size: 11px; line-height: 1.4; cursor: pointer; padding: 3px 7px;
      border-radius: 4px; white-space: nowrap; font-family: inherit;
      transition: color var(--p-dur) var(--p-ease), background var(--p-dur) var(--p-ease), border-color var(--p-dur) var(--p-ease);
    }
    .p-head .mode-btn:hover,
    .p-head .session-btn:hover,
    .p-head .theme:hover { background: var(--p-note); color: var(--p-text); }
    .p-head .theme { display: inline-flex; align-items: center; }

    /* 主题按钮：图形 = 主题本身，比 🌙 ☀️ 🌗 三个 emoji 稳得多（emoji 字形与基线随系统变）。
       跟随系统 = 半明半暗；深色 = 实心；浅色 = 空心。 */
    .p-head .theme::before {
      content: ''; display: block; width: 11px; height: 11px; border-radius: 50%;
      border: 1.4px solid currentColor;
      background: linear-gradient(90deg, currentColor 0 50%, transparent 50% 100%);
    }
    .p-head .theme[data-theme="dark"]::before { background: currentColor; }
    .p-head .theme[data-theme="light"]::before { background: transparent; }
    /* 交接标识芯片：点一下把本次会话打包并复制可直接粘给 AI 的指令 */
    .p-head .handoff { font-family: var(--p-mono); font-size: 10.5px; letter-spacing: .02em; border-color: var(--p-line); background: var(--p-bg); }
    .p-head .handoff:hover { border-color: var(--p-accent-line); color: var(--p-accent); background: var(--p-accent-soft); }
    .p-head .handoff.copied { border-color: var(--p-success); color: var(--p-success); }
    .p-head .session-btn { max-width: 112px; overflow: hidden; text-overflow: ellipsis; }
    .session-menu {
      position: absolute; z-index: 30; top: 44px; right: 10px;
      width: min(340px, calc(100% - 20px)); max-height: min(470px, calc(100vh - 110px));
      display: flex; flex-direction: column;
      background: var(--p-bg); border: 1px solid var(--p-line-strong); border-radius: 9px;
      box-shadow: var(--p-float); overflow: hidden;
    }
    .session-menu[hidden] { display: none; }
    .session-menu-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 9px 11px; font-size: 10.5px; font-weight: 700; letter-spacing: .09em;
      text-transform: uppercase; color: var(--p-text-faint);
      border-bottom: 1px solid var(--p-line);
    }
    .session-menu-close {
      border: none; background: none; color: var(--p-text-faint); cursor: pointer;
      padding: 2px; border-radius: 4px; display: inline-flex;
    }
    .session-menu-close:hover { background: var(--p-note); color: var(--p-text); }
    .session-list { overflow-y: auto; padding: 4px; min-height: 0; }
    .session-item { display: flex; align-items: stretch; border-radius: 5px; border: 1px solid transparent; }
    .session-item:hover { background: var(--p-note); }
    .session-item.active { background: var(--p-accent-soft); border-color: var(--p-accent-line); }
    .session-item.running .session-title { color: var(--p-warn); }
    .session-main {
      flex: 1; min-width: 0; border: none; background: none; text-align: left;
      padding: 7px 6px 7px 9px; cursor: pointer; color: var(--p-text-sub);
      display: flex; flex-direction: column; gap: 2px; font-family: inherit;
    }
    .session-title { font-size: 12px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 230px; color: var(--p-text); }
    .session-meta { font-size: 10.5px; color: var(--p-text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .session-actions { display: flex; align-items: center; gap: 1px; padding-right: 4px; opacity: .5; transition: opacity var(--p-dur) var(--p-ease); }
    .session-item:hover .session-actions, .session-item.active .session-actions, .session-item:focus-within .session-actions { opacity: 1; }
    .session-actions button {
      border: none; background: none; color: var(--p-text-faint); cursor: pointer;
      width: 28px; height: 28px; border-radius: 4px; padding: 0;
      display: inline-flex; align-items: center; justify-content: center;
    }
    .session-actions button:hover { background: var(--p-accent-soft); color: var(--p-accent); }
    .session-actions button[data-session-action="delete"]:hover { background: rgba(163, 44, 44, .12); color: var(--p-danger); }
    .session-empty { padding: 18px 10px; text-align: center; color: var(--p-text-faint); font-size: 12px; }
    .session-new {
      border: none; border-top: 1px solid var(--p-line); background: var(--p-head);
      color: var(--p-accent); padding: 9px 12px; text-align: left;
      font-size: 12px; font-weight: 650; cursor: pointer; font-family: inherit;
    }
    .session-new:hover { background: var(--p-accent-soft); }
    .session-dialog-backdrop {
      position: absolute; inset: 0; z-index: 60; background: rgba(28, 24, 18, .46);
      display: flex; align-items: center; justify-content: center; padding: 18px;
    }
    .session-dialog {
      width: min(390px, 100%); background: var(--p-bg); border: 1px solid var(--p-line-strong);
      border-radius: 9px; box-shadow: var(--p-float); padding: 16px; color: var(--p-text);
    }
    .session-dialog-title { font-size: 14px; font-weight: 650; margin-bottom: 7px; }
    .session-dialog-message { font-size: 12.5px; line-height: 1.65; color: var(--p-text-sub); margin-bottom: 11px; word-break: break-word; }
    .session-dialog-input {
      width: 100%; border: 1px solid var(--p-line-strong); border-radius: 5px;
      padding: 7px 9px; font-size: 13px; outline: none; margin-bottom: 13px;
      background: var(--p-bg); color: var(--p-text); font-family: inherit;
      transition: border-color var(--p-dur) var(--p-ease), box-shadow var(--p-dur) var(--p-ease);
    }
    .session-dialog-input:focus { border-color: var(--p-accent); box-shadow: 0 0 0 3px var(--p-accent-soft); }
    .session-dialog-actions { display: flex; justify-content: flex-end; gap: 7px; flex-wrap: wrap; }
    .session-dialog-actions button {
      border: 1px solid var(--p-line-strong); background: var(--p-bg); color: var(--p-text-sub);
      border-radius: 5px; padding: 6px 11px; font-size: 12px; cursor: pointer; font-family: inherit;
      transition: color var(--p-dur) var(--p-ease), border-color var(--p-dur) var(--p-ease), background var(--p-dur) var(--p-ease);
    }
    .session-dialog-actions button:hover { border-color: var(--p-accent-line); color: var(--p-accent); }
    .session-dialog-actions .primary { background: var(--p-accent); border-color: var(--p-accent); color: #fffdf8; }
    .session-dialog-actions .primary:hover { background: var(--p-accent-hover); border-color: var(--p-accent-hover); color: #fffdf8; }
    .session-dialog-actions .danger { background: var(--p-danger); border-color: var(--p-danger); color: #fffdf8; }
    .session-dialog-actions .danger:hover { border-color: var(--p-danger); color: #fffdf8; filter: brightness(.94); }
    .session-dialog-actions .session-dialog-extra { margin-right: auto; color: var(--p-accent); border-color: transparent; background: none; }
    /* 「本次引用的选区」提示条：左侧一条朱砂细线 + 纸底，像一个页边批注 */
    .p-text {
      display: flex; align-items: flex-start; gap: 8px;
      /* 两行引文的批注条。min-height 不是装饰：E2E 断言引用条不能被压成一行
         （界面里「引用」和「随手一句」必须一眼分得开），48px 那版会被判不合格。 */
      min-height: 52px;
      margin: 0; padding: 10px 8px 10px 12px; font-size: 12px; color: var(--p-text-sub); line-height: 1.65;
      border-left: 2px solid var(--p-accent-line); background: var(--p-note);
      user-select: none; flex-shrink: 0;
    }
    .p-text-quote {
      grid-area: quote; flex: 1 1 auto; min-width: 0; max-height: 42px; overflow: hidden;
      white-space: pre-wrap; word-break: break-word;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    }
    .p-text-clear {
      grid-area: clear; align-self: start;
      flex: 0 0 auto; border: none; background: transparent; color: var(--p-text-faint);
      width: 24px; height: 24px; border-radius: 4px; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
    }
    .p-text-clear:hover { color: var(--p-danger); background: rgba(163, 44, 44, .1); }

    /* 关闭 / 移除的叉号：两条 1.4px 描边旋转 45° 拼成，不依赖任何字形。
       × ✕ ✖ 在各平台字宽、基线、粗细都不同 —— 面板里满屏这种「随手字符」
       正是「AI 味」的来源之一。 */
    .p-head .close::before,
    .session-menu-close::before,
    .p-text-clear::before,
    .pick-chip .pick-clear::before {
      content: ''; display: block; width: 11px; height: 11px; opacity: .9;
      background:
        linear-gradient(currentColor, currentColor) center / 11px 1.4px no-repeat,
        linear-gradient(currentColor, currentColor) center / 1.4px 11px no-repeat;
      transform: rotate(45deg);
    }
    /* margin-right 是 --rf-edge：把滚动条推到右侧 resize 手柄的左边。
       少了这一句，手柄（绝对定位 + z-index:5）会压住滚动条，滚动条就点不动、拖不动。 */
    .p-body {
      padding: 12px 14px; margin-right: var(--rf-edge);
      overflow-y: auto; flex: 1 1 auto;
      font-size: 13px; line-height: 1.72; color: var(--p-text);
      word-break: break-word; min-height: 0;
      scrollbar-width: thin; scrollbar-color: var(--p-line-strong) transparent;
    }
    .p-body:focus { outline: none; }
    .p-body::-webkit-scrollbar { width: 8px; }
    .p-body::-webkit-scrollbar-thumb { background: var(--p-line-strong); border-radius: 999px; }
    .p-body::-webkit-scrollbar-thumb:hover { background: var(--p-text-faint); }
    .p-body::-webkit-scrollbar-track { background: transparent; }
    /* 嵌入态没有右缘手柄（只有左缘），那条为手柄预留的 10px 右边距纯属浪费宽度 ——
       在本来就窄的一栏里，正好等于白扔 10px 的对话宽度。 */
    .panel.embedded .p-body { margin-right: 0; }
    .p-body.loading { color: var(--p-text-faint); }
    .p-body.error { color: var(--p-danger); }
    .msg { margin-bottom: 14px; max-width: 100%; }
    /* 用户消息不做「气泡」：一段加了引线（左侧朱砂细线）的行内引用块，
       和下面的助手正文同处一条基线，读起来像对话记录而不是聊天 app。 */
    .msg.user {
      background: var(--p-note); color: var(--p-text);
      border: 1px solid var(--p-line); border-left: 2px solid var(--p-accent);
      border-radius: 4px 6px 6px 4px;
      padding: 8px 12px; margin-left: auto; white-space: pre-wrap;
      width: fit-content; font-size: 13px;
    }
    .msg.ai { background: transparent; padding: 0 2px; margin-right: 6px; }

    /* 空对话：品牌标 + 一句说明，居左顶格；不铺「欢迎使用」那种空话 */
    .p-body .p-empty { padding: 16px 2px 0; }
    .p-body .p-empty-mark { display: block; width: 26px; height: 26px; opacity: .5; margin-bottom: 10px; }
    .p-body .p-empty-line { margin: 0; max-width: 32em; font-size: 12.5px; line-height: 1.75; color: var(--p-text-faint); }
    /* 用户气泡里「这条消息带上了哪些拾取元素」那一行。
       它必须**留在气泡内**：那是这条消息的上下文，不是提示条 ——
       放到气泡外就又会变成"发送后消失的临时状态"。 */
    .user-picks { display: block; margin-top: 4px; font-size: 11px; line-height: 1.5; color: var(--p-text-faint); word-break: break-all; }
    .user-selection {
      display: block; margin-top: 5px; padding-top: 5px;
      border-top: 1px solid var(--p-line);
      font-size: 11px; line-height: 1.5; color: var(--p-text-sub);
    }
    .user-selection-label { display: block; margin-bottom: 1px; font-size: 10px; color: var(--p-text-faint); }
    .user-selection-text {
      display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3;
      overflow: hidden; white-space: pre-wrap; word-break: break-word;
    }
    .msg.ai .typing { color: var(--p-text-faint); }
    .typing { display: inline-flex; gap: 4px; align-items: center; }
    .typing span { width: 5px; height: 5px; border-radius: 50%; background: currentColor; animation: kb-bounce 1.2s infinite; }
    .typing span:nth-child(2) { animation-delay: .15s; }
    .typing span:nth-child(3) { animation-delay: .3s; }
    @keyframes kb-bounce { 0%,60%,100% { transform: translateY(0); opacity: .4; } 30% { transform: translateY(-3px); opacity: 1; } }
    /* ---- 思考记录（思维链）----
       只有**推理模型**会产出内容（deepseek-reasoner）；deepseek-chat 下这一块不会出现，
       用户看到的仍是上面那三个点 + FAB 呼吸动画。
       展开/收起由 data-open 控制；进行中的动画只在 data-state="running" 时跑 ——
       静止的思考记录不该继续闪，否则用户会误以为还在生成。 */
    .think-block { margin: 6px 0 8px; border-left: 2px solid var(--p-line-strong); background: transparent; overflow: hidden; }
    .think-head {
      display: flex; align-items: center; gap: 6px; width: 100%; padding: 4px 0 4px 8px;
      background: none; border: 0; cursor: pointer; font: inherit; font-size: 11.5px;
      color: var(--p-text-faint); text-align: left;
      transition: color var(--p-dur) var(--p-ease);
    }
    .think-head:hover { color: var(--p-accent); }
    .think-label { flex: 1 1 auto; }
    .think-caret { flex: 0 0 auto; display: inline-flex; transition: transform var(--p-dur) var(--p-ease); }

    .think-caret::before {
      content: ''; display: block; width: 5px; height: 5px; margin-right: 2px;
      border-right: 1.4px solid currentColor; border-bottom: 1.4px solid currentColor;
      transform: rotate(-45deg);
    }
    .think-block[data-open="true"] .think-caret { transform: rotate(90deg); }
    .think-dots { display: inline-flex; flex: 0 0 auto; gap: 3px; align-items: center; }
    .think-dots span { width: 3px; height: 3px; border-radius: 50%; background: currentColor; opacity: .45; }
    .think-block[data-state="running"] .think-dots span { opacity: 1; animation: kb-bounce 1.2s infinite; }
    .think-block[data-state="running"] .think-dots span:nth-child(2) { animation-delay: .15s; }
    .think-block[data-state="running"] .think-dots span:nth-child(3) { animation-delay: .3s; }
    /* 进行中：标签走一遍扫光，长思维链里比三个点更容易被注意到。
       ⚠ 必须用 @supports 包住：background-clip:text 不生效时 -webkit-text-fill-color:transparent
       会把**文字整个变没**（只剩一条看不见的渐变），这是宁可不动画也不能冒的险。 */
    @supports ((-webkit-background-clip: text) or (background-clip: text)) {
      .think-block[data-state="running"] .think-label {
        background: linear-gradient(90deg, currentColor 0%, var(--p-accent) 45%, currentColor 90%);
        background-size: 220% 100%;
        -webkit-background-clip: text; background-clip: text;
        -webkit-text-fill-color: transparent;
        animation: kb-shimmer 1.6s linear infinite;
      }
    }
    @keyframes kb-shimmer { from { background-position: 220% 0; } to { background-position: -220% 0; } }
    /* ⚠ 刻意**不设** max-height / overflow：
       思考记录是对话流里的一段，应该跟着对话一起长、一起滚 —— 由面板自身的滚动条负责。
       给它加内层滚动条会有两个问题：① 滚轮停在内层时滚不动外层，操作很别扭；
       ② 思考与它前后的叙述/工具步骤不在同一个滚动坐标里，看不出对应关系。 */
    .think-body { display: none; padding: 0 0 6px 8px; font-size: 12px; line-height: 1.66; color: var(--p-text-sub); white-space: pre-wrap; word-break: break-word; }
    .think-block[data-open="true"] .think-body { display: block; }
    .p-body h1, .p-body h2, .p-body h3, .p-body h4 { margin: 16px 0 8px; line-height: 1.42; font-weight: 650; letter-spacing: -.005em; }
    .p-body h1 { font-size: 17px; } .p-body h2 { font-size: 15px; } .p-body h3 { font-size: 14px; } .p-body h4 { font-size: 13px; }
    .p-body h1:first-child, .p-body h2:first-child, .p-body h3:first-child { margin-top: 2px; }
    .msg.ai > :first-child { margin-top: 2px; }
    .msg.ai > :last-child { margin-bottom: 2px; }
    .p-body p { margin: 8px 0; }
    .p-body ul, .p-body ol { margin: 8px 0; padding-left: 20px; }
    .p-body li { margin: 4px 0; }
    .p-body li::marker { color: var(--p-accent-line); }
    /* 行内代码 = 一枚浅纸底的小标记，不要蓝底蓝字 */
    .p-body code {
      background: var(--p-note); color: var(--p-text);
      border: 1px solid var(--p-line); border-radius: 3px;
      padding: 0 5px; font-size: 11.5px; font-family: var(--p-mono);
    }
    /* 代码块走「纸上的排版稿」：浅纸底 + 发丝框 + 无投影，语言名做小 caps */
    .code-wrap { position: relative; margin: 10px 0; border: 1px solid var(--p-line); border-radius: 6px; background: var(--p-code-bg); overflow: hidden; }
    .panel.dark .code-wrap { border-color: var(--p-line-strong); }
    .code-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 4px 10px; border-bottom: 1px solid var(--p-line);
      background: transparent;
    }
    .code-lang {
      font-size: 10px; color: var(--p-text-faint); letter-spacing: .09em;
      text-transform: uppercase; user-select: none; font-family: var(--p-mono);
    }
    .code-wrap pre { background: transparent; padding: 10px 12px; overflow-x: auto; margin: 0; }
    .code-wrap pre code {
      background: none; border: 0; padding: 0; color: var(--p-text);
      font-size: 11.5px; line-height: 1.72; font-family: var(--p-mono);
    }
    .code-copy {
      border: none; background: none; color: var(--p-text-faint);
      border-radius: 4px; padding: 2px 6px; font-size: 10.5px; cursor: pointer;
      font-family: inherit; transition: color var(--p-dur) var(--p-ease), background var(--p-dur) var(--p-ease); line-height: 1.6;
      display: inline-flex; align-items: center; gap: 4px;
    }
    .code-copy:hover { color: var(--p-text); background: var(--p-line); }
    .code-copy.copied { color: var(--p-success); }
    .tk-comment { color: #857c6c; font-style: italic; }
    .tk-string { color: #2e6a4e; }
    .tk-number { color: #8a5a00; }
    .tk-keyword { color: #a03a22; font-weight: 600; }
    .tk-type { color: #5b4a86; }
    .tk-fn { color: #2369b3; }
    .panel.dark .tk-comment { color: #8e8577; }
    .panel.dark .tk-string { color: #9ad3ae; }
    .panel.dark .tk-number { color: #e6b866; }
    .panel.dark .tk-keyword { color: #e08a63; }
    .panel.dark .tk-type { color: #c3a9f0; }
    .panel.dark .tk-fn { color: #8fc3f0; }
    .p-body blockquote {
      background: transparent; border-left: 2px solid var(--p-line-strong);
      padding: 2px 0 2px 12px; color: var(--p-text-sub); margin: 10px 0;
      border-radius: 0; font-style: normal;
    }
    .p-body a { color: var(--p-accent); text-decoration: none; border-bottom: 1px solid var(--p-accent-line); }
    .p-body a:hover { border-bottom-color: var(--p-accent); }
    .p-body strong { font-weight: 650; color: var(--p-text); }
    .p-body hr { border: none; border-top: 1px solid var(--p-line); margin: 16px 0; }
    .md-table-wrap { margin: 10px 0; overflow-x: auto; border: 1px solid var(--p-line); border-radius: 5px; }
    .p-body table { border-collapse: collapse; width: 100%; font-size: 12px; }
    .p-body th, .p-body td { padding: 6px 10px; border-bottom: 1px solid var(--p-line); text-align: left; vertical-align: top; }
    .p-body th { background: var(--p-note); font-weight: 650; font-size: 11px; color: var(--p-text-sub); }
    .p-body tbody tr:nth-child(even) { background: rgba(160, 58, 34, .03); }
    .p-body tr:last-child td { border-bottom: none; }
    .stream-cursor {
      position: absolute; z-index: 1; width: 2px; height: 14px; margin-left: 2px;
      background: var(--p-accent); pointer-events: none;
      animation: kb-cursor .9s steps(2, start) infinite;
    }
    @keyframes kb-cursor { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
    .msg-actions { display: flex; gap: 2px; margin-top: 6px; opacity: 0; transition: opacity var(--p-dur) var(--p-ease); }
    .msg.ai:hover .msg-actions, .msg-actions:hover { opacity: 1; }
    .msg-actions button {
      border: none; background: none; color: var(--p-text-faint); font-size: 11px; cursor: pointer;
      padding: 3px 7px; border-radius: 4px; font-family: inherit;
      display: inline-flex; align-items: center; gap: 4px;
      transition: background var(--p-dur) var(--p-ease), color var(--p-dur) var(--p-ease);
    }
    .msg-actions button:hover { background: var(--p-note); color: var(--p-text); }
    .stopped-note { margin-top: 6px; font-size: 11px; color: var(--p-text-faint); user-select: none; }
    .p-foot { display: flex; gap: 6px; padding: 7px 12px; border-top: 1px solid var(--p-line); flex-wrap: wrap; }
    .p-foot button {
      border: 1px solid var(--p-line-strong); background: var(--p-bg); color: var(--p-text-sub);
      border-radius: 5px; padding: 5px 10px; min-height: 28px; font-size: 11.5px; cursor: pointer;
      font-family: inherit;
      transition: color var(--p-dur) var(--p-ease), border-color var(--p-dur) var(--p-ease), background var(--p-dur) var(--p-ease);
    }
    .p-foot button:hover { border-color: var(--p-accent-line); color: var(--p-accent); }
    .p-foot .spacer { flex: 1; }
    .p-foot .copy-btn { margin-left: auto; }
    /* 第二个导出按钮（导出完整）紧挨着上一个：两个都吃 margin-left:auto 的话，
       自动外边距会在它们之间也撑开一段，页脚变成「clear …… 导出记录 …… 导出完整 停止」。 */
    .p-foot .copy-btn + .copy-btn { margin-left: 6px; }
    .p-foot .stop-btn { border-color: var(--p-danger); color: var(--p-danger); font-weight: 650; }
    .p-foot .stop-btn:hover { border-color: var(--p-danger); color: #fffdf8; background: var(--p-danger); }
    .cmd-area { padding: 8px 12px 10px; border-top: 1px solid var(--p-line); flex-shrink: 0; background: var(--p-bg); }
    .cmd-box { display: flex; gap: 6px; align-items: stretch; }
    .cmd-input {
      flex: 1; resize: none; border: 1px solid var(--p-line-strong); border-radius: 5px;
      padding: 7px 10px; font-size: 12.5px; font-family: inherit; outline: none;
      background: var(--p-bg); color: var(--p-text); min-height: 34px; max-height: 120px; line-height: 1.5;
      transition: border-color var(--p-dur) var(--p-ease), box-shadow var(--p-dur) var(--p-ease);
    }
    .cmd-input:focus { border-color: var(--p-accent); box-shadow: 0 0 0 3px var(--p-accent-soft); }
    .cmd-input::placeholder { color: var(--p-text-faint); }
    .cmd-send {
      border: 1px solid var(--p-accent); background: var(--p-accent); color: #fffdf8;
      border-radius: 5px; padding: 0 14px; font-size: 12.5px; font-weight: 600; cursor: pointer;
      font-family: inherit; flex-shrink: 0; min-height: 36px;
      display: inline-flex; align-items: center; gap: 5px;
      transition: background var(--p-dur) var(--p-ease), border-color var(--p-dur) var(--p-ease);
    }
    .cmd-send:hover { background: var(--p-accent-hover); border-color: var(--p-accent-hover); }
    .cmd-send:disabled { opacity: .45; cursor: not-allowed; }
    /* ⚠ 这两条是 tests/ui-optimization.test.mjs 的断言目标：必须保持 flex-wrap:wrap 且不出现 overflow-x:auto。
       嵌入态的单行滚动在下面用更具体的选择器单独覆盖。 */
    .quick-prompts { display: flex; gap: 6px; flex-wrap: wrap; align-items: flex-start; padding: 0 0 2px; margin: 0 0 7px; }
    .quick-prompt {
      flex: 0 1 auto; min-width: 0; max-width: 100%;
      border: 1px solid var(--p-line); background: transparent; color: var(--p-text-sub);
      border-radius: 3px; padding: 4px 8px; min-height: 26px; font-size: 11.5px; line-height: 1.35;
      cursor: pointer; white-space: normal; overflow-wrap: anywhere; text-align: left;
      font-family: inherit;
      transition: background var(--p-dur) var(--p-ease), border-color var(--p-dur) var(--p-ease), color var(--p-dur) var(--p-ease);
    }
    .quick-prompt:hover { background: var(--p-accent-soft); border-color: var(--p-accent-line); color: var(--p-accent); }
    /* 嵌入态那一栏通常只有 380–500px：快捷提示折成两行会白吃掉约 30px 对话区，
       改成单行横向滚动，高度稳定在一行 —— 对话区本来就窄，不能让它再被按钮挤掉。 */
    .panel.embedded .quick-prompts { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; }
    .panel.embedded .quick-prompts::-webkit-scrollbar { display: none; }
    .panel.embedded .quick-prompt { flex: 0 0 auto; }
    .pick-bar { display: flex; flex-wrap: wrap; gap: 5px; margin: 0 0 7px; }
    .pick-chip {
      display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px;
      color: var(--p-text-sub); background: var(--p-note); border: 1px solid var(--p-line);
      border-radius: 3px; padding: 2px 7px; max-width: 100%; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap;
    }
    .pick-chip .pick-clear { border: none; background: none; color: inherit; cursor: pointer; padding: 0; font-family: inherit; display: inline-flex; opacity: .7; }
    .pick-chip .pick-clear:hover { opacity: 1; color: var(--p-danger); }
    .pick-chip .pick-chip-text { overflow: hidden; text-overflow: ellipsis; max-width: 220px; }
    .pick-chip .pick-copy { border: none; background: none; color: inherit; cursor: pointer; padding: 0 1px; font-family: inherit; opacity: .6; display: inline-flex; }
    .pick-chip .pick-copy:hover { opacity: 1; color: var(--p-accent); }
    .pick-clear-all {
      border: none; background: none; color: var(--p-text-faint); padding: 2px 4px;
      font-size: 10.5px; cursor: pointer; font-family: inherit;
    }
    .pick-clear-all:hover { color: var(--p-accent); }
    .cmd-pick {
      display: inline-flex; align-items: center; justify-content: center;
      border: 1px solid var(--p-line-strong); background: var(--p-bg); color: var(--p-text-sub);
      border-radius: 5px; padding: 0 9px; min-width: 36px; min-height: 36px;
      cursor: pointer; flex-shrink: 0; font-family: inherit; white-space: nowrap;
      transition: color var(--p-dur) var(--p-ease), border-color var(--p-dur) var(--p-ease), background var(--p-dur) var(--p-ease);
    }
    .cmd-pick:hover { border-color: var(--p-accent-line); color: var(--p-accent); }
    .cmd-pick.active { background: var(--p-accent); color: #fffdf8; border-color: var(--p-accent); }
    .suggestion-options { display: flex; flex-wrap: wrap; gap: 5px; margin: 8px 0 2px; }
    .suggestion-title { width: 100%; font-size: 10.5px; color: var(--p-text-faint); letter-spacing: .02em; }
    .suggestion-option {
      border: 1px solid var(--p-accent-line); color: var(--p-accent); background: none;
      border-radius: 3px; padding: 3px 9px; font-size: 11px; cursor: pointer; font-family: inherit;
      transition: background var(--p-dur) var(--p-ease);
    }
    .suggestion-option:hover { background: var(--p-accent-soft); }
    /* 悬浮球：一枚贴在页面上的「印章」—— 纸色圆片 + 发丝框 + 品牌标，
       不用渐变、不用内高光、不用霓虹投影；它只是安静地待在那儿。 */
    .fab {
      position: fixed; right: 16px; top: 38%; z-index: 2147483646;
      width: 52px; height: 52px; border: 1px solid var(--p-line-strong); border-radius: 50%;
      background: #fffdf8;
      color: var(--p-text); display: flex; align-items: center; justify-content: center;
      cursor: grab;
      box-shadow: 0 6px 18px rgba(38, 30, 18, .18), 0 1px 2px rgba(38, 30, 18, .1);
      /* ⚠ right 必须进过渡列表：收起 / 展开滑的是 right（见下面 .fab.peek）。
         漏了它，悬浮时气泡会瞬间跳出来 —— 那就是验收标准 2 里的"无跳变"没过。 */
      transition: right .22s var(--p-ease), transform .18s var(--p-ease), box-shadow .18s var(--p-ease);
      user-select: none; touch-action: none;
    }
    .user-turn { width: fit-content; max-width: 96%; margin: 0 0 14px auto; }
    .user-turn .msg { margin-bottom: 3px; }
    .user-actions { display: flex; justify-content: flex-end; align-items: center; opacity: 0; transition: opacity var(--p-dur) var(--p-ease); }
    .user-turn:hover .user-actions, .user-actions:hover { opacity: 1; }
    .user-actions button {
      border: none; background: none; color: var(--p-text-faint); font-size: 11px;
      cursor: pointer; padding: 3px 7px; border-radius: 4px; font-family: inherit;
    }
    .user-actions button:hover { background: var(--p-note); color: var(--p-text); }
    @media (hover: none) { .msg-actions, .user-actions { opacity: 1; } }
    .fab::before { content: none; }
    /* 状态点：扩展在运行。不是装饰，所以保持小、低饱和。 */
    .fab::after {
      content: ''; position: absolute; right: 1px; bottom: 3px;
      width: 8px; height: 8px; border-radius: 50%;
      background: #2e6a4e; border: 2px solid #fffdf8;
    }
    .fab:hover { transform: translateY(-1px); box-shadow: 0 10px 24px rgba(38, 30, 18, .22), 0 1px 2px rgba(38, 30, 18, .12); }
    .fab:active { transform: translateY(0) scale(.98); }
    .fab.dragging { cursor: grabbing; transform: scale(.98); transition: none; }
    .fab:focus-visible { outline: 2px solid var(--p-accent); outline-offset: 3px; }
    .fab img { width: 30px; height: 30px; object-fit: contain; position: relative; z-index: 1; }
    .fab.hidden { display: none; }
    .fab.thinking { animation: fab-pulse 1.4s var(--p-ease) infinite; }
    @keyframes fab-pulse {
      0%,100% { box-shadow: 0 6px 18px rgba(38, 30, 18, .18), 0 0 0 0 rgba(160, 58, 34, .28); }
      50% { box-shadow: 0 8px 22px rgba(38, 30, 18, .22), 0 0 0 7px rgba(160, 58, 34, 0); }
    }
    /* TITA-36 收起态：整颗气泡向右推出视口，只留 FAB_PEEK_VISIBLE(12px) 在视口里。
       算术：宽屏 52 - 12 = 40；窄屏（下面那条媒体查询）46 - 12 = 34。
       气泡直径改了，这两个数必须跟着改，否则不是露太多就是露不着。 */
    .fab.peek { right: -40px; }
    @media (max-width: 600px) {
      .fab { right: 12px; width: 46px; height: 46px; }
      .fab img { width: 26px; height: 26px; }
      .fab.peek { right: -34px; }
    }
    @media (hover: none) {
      /* 触屏没有"悬浮"这回事：收起态唤不回来，只剩 12px 的点不到。
         没有 hover 能力的设备直接取消收起。 */
      .fab.peek { right: 16px; }
    }
    @media (hover: none) and (max-width: 600px) { .fab.peek { right: 12px; } }
    /* 悬浮球右键菜单（打开面板 / 隐藏悬浮球）：挂在球所在的同一个 shadow root 里，
       position:fixed 相对视口，摆在球左侧（球贴右缘，菜单向左展开）。
       没有这个菜单时右键只会弹宿主页面自己的默认菜单 —— 悬浮球没有任何退出途径。 */
    .fab-menu {
      position: fixed; z-index: 2147483647;
      display: flex; flex-direction: column; gap: 1px;
      background: #fffdf8; border: 1px solid var(--p-line-strong); border-radius: 7px;
      box-shadow: 0 10px 28px rgba(38, 30, 18, .22);
      padding: 5px; animation: kb-pop .12s var(--p-ease);
    }
    .fab-menu button {
      border: none; background: none; text-align: left; font-family: inherit;
      font-size: 12px; color: var(--p-text); padding: 7px 11px; border-radius: 4px;
      cursor: pointer; white-space: nowrap;
      transition: background var(--p-dur) var(--p-ease), color var(--p-dur) var(--p-ease);
    }
    .fab-menu button:hover { background: var(--p-note); }
    .fab-menu button.danger { color: var(--p-danger); }
    .fab-menu button.danger:hover { background: rgba(163, 44, 44, .1); }
    .fab-menu.dark { background: #211e18; border-color: var(--p-line-strong); }
    .fab-menu.dark button { color: #ede7db; }
    .fab-menu.dark button:hover { background: #2a2620; }
    .fab-menu.dark button.danger { color: #e08a80; }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; scroll-behavior: auto !important; }
    }
    /* 引用标记：正文里的 [1] 不是按钮，是一枚上标式的编号；hover 才显出朱砂 */
    .cite-badge {
      display: inline-flex; align-items: center; gap: 3px;
      background: var(--p-note); color: var(--p-text-sub);
      border: 1px solid var(--p-line); border-radius: 3px;
      padding: 0 5px; margin: 0 2px; font-size: 10.5px; line-height: 1.6;
      cursor: pointer; user-select: none; vertical-align: baseline;
      font-family: inherit; max-width: 220px; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap;
      transition: color var(--p-dur) var(--p-ease), border-color var(--p-dur) var(--p-ease), background var(--p-dur) var(--p-ease);
    }
    .cite-badge:hover { background: var(--p-accent-soft); color: var(--p-accent); border-color: var(--p-accent-line); }
    .cite-badge .cite-idx { font-weight: 700; flex-shrink: 0; font-variant-numeric: tabular-nums; }
    .cite-sources {
      margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--p-line);
      display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
    }
    .cite-sources .cite-label { font-size: 10.5px; color: var(--p-text-faint); margin-right: 2px; }
    .agent-steps { display: flex; flex-direction: column; gap: 4px; margin: 2px 0 8px; }
    .agent-flow { position: relative; display: flex; flex-direction: column; gap: 4px; margin: 2px 0 8px; }
    .agent-plan { margin: 2px 0 8px; padding: 8px 10px; border: 1px solid var(--p-line); border-radius: 5px; background: var(--p-note); }
    .agent-plan-title { font-size: 10.5px; font-weight: 700; letter-spacing: .04em; color: var(--p-text-faint); margin-bottom: 5px; }
    .agent-plan-item { font-size: 11.5px; line-height: 1.6; color: var(--p-text-sub); }
    .agent-plan-item.done { color: var(--p-success); text-decoration: line-through; opacity: .8; }
    .agent-plan-item.in_progress { color: var(--p-accent); font-weight: 650; }

    /* 计划行首的三态点：空心=待办、实心=完成、朱砂=进行中（配 2px 光晕强调「当前」） */
    .plan-mark {
      display: inline-block; width: 5px; height: 5px; margin-right: 6px; border-radius: 50%;
      border: 1.4px solid currentColor; vertical-align: middle;
    }
    .agent-plan-item.done .plan-mark { background: currentColor; }
    .agent-plan-item.pending .plan-mark { opacity: .5; }
    .agent-plan-item.in_progress .plan-mark {
      background: var(--p-accent); border-color: var(--p-accent);
      box-shadow: 0 0 0 2px var(--p-accent-soft);
    }
    /* 执行计划条：位于**底部控件区的第一格**（快捷指令之上、对话之下）。
       位置试过四轮才对：贴助手消息开头会随对话滚走；贴对话区顶部会压住内容
       （计划是过程、对话是内容，过程不该占内容区最顶上的版面）；紧贴输入框时
       会和审批 / 快捷指令 / 自动批准 / 拾取栏挤在一起，而那一格里只有输入框属于「输入」。
       现在它在对话之外、又和用户操作的那一整块在一起。

       **刻意不设 max-height / overflow-y**：限高加内层滚动条会把计划条变成一个小滚动框，
       既难看又要二次滚动。步骤过多改为「收成一行 / 点击展开全部」——
       展开时不设高度上限，因此任何情况下都不会出现内层滚动条。 */
    .agent-plan-bar { margin: 0 0 8px; }
    .agent-plan-bar .agent-plan-title { display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; }
    .agent-plan-bar .agent-plan-title:hover { color: var(--p-accent); }
    .agent-plan-bar .agent-plan-title::before {
      content: ''; width: 5px; height: 5px; background: var(--p-accent); flex: none; transform: rotate(45deg);
    }
    /* 收起态：一行标题，列表整块不渲染。 */
    .agent-plan-bar.collapsed { padding: 6px 10px; }
    .agent-plan-bar.collapsed .agent-plan-title { margin-bottom: 0; }
    .agent-plan-bar.collapsed .agent-plan-items { display: none; }
    .agent-step {
      font-size: 11.5px; line-height: 1.55; color: var(--p-text-sub);
      background: transparent; border-left: 2px solid var(--p-line);
      padding: 3px 0 3px 8px; border-radius: 0; word-break: break-word;
    }
    .agent-step.verify-final { margin-top: 8px; }
    .agent-tool { font-weight: 650; color: var(--p-text); }
    .agent-tool-arg { color: inherit; opacity: .8; }
    /* 工具步骤可展开：args 与 result 本就存在 parts 里却从不渲染，
       用户只能开 DevTools 才能知道「它到底读到了什么」。 */
    .agent-step > summary { cursor: pointer; list-style: none; display: flex; gap: 5px; align-items: baseline; outline: none; }
    .agent-step > summary::-webkit-details-marker { display: none; }
    /* 展开指示：用旋转 45° 的小描边方块做 chevron，不用 ▸ ▾ 字形（字形随字体乱跳） */
    .agent-step > summary::before {
      content: ''; flex-shrink: 0; width: 4px; height: 4px; margin-right: 1px;
      border-right: 1.4px solid currentColor; border-bottom: 1.4px solid currentColor;
      transform: rotate(-45deg) translateY(-1px); opacity: .7;
      transition: transform var(--p-dur) var(--p-ease);
    }
    .agent-step[open] > summary::before { transform: rotate(45deg); }
    .agent-step > summary:focus-visible { outline: 2px solid var(--p-accent); outline-offset: 2px; border-radius: 2px; }
    .agent-step-detail { margin: 5px 0 1px; padding-top: 5px; border-top: 1px solid var(--p-line); }
    .agent-step-label { font-size: 10px; font-weight: 700; letter-spacing: .04em; color: var(--p-text-faint); margin: 3px 0 2px; }
    .agent-step-pre {
      margin: 0; padding: 5px 7px; border-radius: 3px; border: 1px solid var(--p-line);
      background: var(--p-code-bg); font-size: 10.5px; line-height: 1.5;
      white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow: auto;
      font-family: var(--p-mono);
    }
    /* 验证码 / 人工确认提示：黄色的「便签」，不是红色警报框 */
    .auth-challenge {
      margin: 5px 0 8px; padding: 8px 10px;
      border: 1px solid var(--p-warn-line); border-left: 3px solid var(--p-warn);
      border-radius: 4px; background: var(--p-warn-bg); color: var(--p-warn);
      font-size: 11.5px; line-height: 1.6;
    }
    .auth-challenge-title { font-weight: 700; margin-bottom: 2px; }

    .auth-challenge-title::before {
      content: ''; display: inline-block; width: 6px; height: 6px; margin-right: 6px;
      background: var(--p-warn); vertical-align: middle;
    }
    .auth-challenge-summary { word-break: break-word; }
    .auth-challenge-link {
      display: inline-flex; align-items: center; margin-top: 6px; padding: 3px 9px;
      border: 1px solid var(--p-warn-line); border-radius: 3px; background: transparent;
      color: var(--p-warn); font-weight: 650; text-decoration: none; font-size: 11px;
    }
    .auth-challenge-link:hover { border-color: var(--p-warn); }
    .auth-challenge-link:focus-visible { outline: 2px solid var(--p-accent); outline-offset: 2px; }
    /* 截图：给用户的可视证据（模型看不到图，所以只作展示） */
    .agent-shot { margin: 6px 0; }
    .agent-shot img { display: block; max-width: 100%; max-height: 190px; border: 1px solid var(--p-line-strong); border-radius: 4px; cursor: zoom-in; background: var(--p-bg); }
    .agent-shot-cap { display: block; margin-top: 3px; font-size: 10.5px; color: var(--p-text-faint); }
    .agent-shot.gone { font-size: 11px; color: var(--p-text-faint); padding: 3px 6px; border: 1px dashed var(--p-line-strong); border-radius: 3px; }
    .shot-lightbox { position: absolute; inset: 0; background: rgba(20, 17, 12, .86); z-index: 30; display: flex; align-items: center; justify-content: center; padding: 12px; cursor: zoom-out; }
    .shot-lightbox img { max-width: 100%; max-height: 100%; border-radius: 4px; }
    /* 进度与耗时：长任务不再黑箱 */
    .p-progress {
      display: none; align-items: center; gap: 8px; padding: 5px 14px;
      font-size: 11px; color: var(--p-text-faint); background: var(--p-note);
      border-bottom: 1px solid var(--p-line); flex-shrink: 0;
    }
    .p-progress.on { display: flex; }
    .p-progress .pp-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--p-accent); animation: kb-blink 1.2s infinite; flex-shrink: 0; }
    .p-progress .pp-msg { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .p-progress .pp-time { font-variant-numeric: tabular-nums; opacity: .85; flex-shrink: 0; }
    /* 高风险工具审批：给完整代码而不是截断到 400 字符 */
    .tool-approval {
      margin: 10px 0; padding: 12px;
      border: 1px solid var(--p-warn-line); border-radius: 6px;
      background: var(--p-warn-bg); font-size: 12px; color: var(--p-text);
    }
    .tool-approval-title { display:flex; align-items:center; gap:7px; font-weight: 650; font-size: 12.5px; margin-bottom: 7px; color: var(--p-text); }
    .tool-approval-title::before {
      content: ''; display: block; flex: none; width: 6px; height: 6px;
      background: var(--p-warn); transform: rotate(45deg);
    }
    .tool-approval-summary { margin-bottom: 9px; line-height: 1.6; color: var(--p-text-sub); }
    .tool-approval-tool {
      display:inline-flex; padding:1px 6px; border-radius:3px;
      border: 1px solid var(--p-line); background: var(--p-bg);
      font-family: var(--p-mono); font-size: 11px; color: var(--p-text);
    }
    .tool-approval-risk {
      display:inline-flex; margin-left:6px; padding:1px 6px; border-radius: 999px;
      background: rgba(163, 44, 44, .1); color: var(--p-danger); font-size: 10px; font-weight: 650;
    }
    .tool-approval-detail {
      margin:0 0 10px; padding:7px 8px; max-height:72px; overflow:auto;
      border:1px solid var(--p-line); border-radius:3px; background: var(--p-code-bg);
      color: var(--p-text-sub); font-size:11px; word-break:break-word; font-family: var(--p-mono);
    }
    .tool-approval-code {
      margin: 4px 0 0; padding: 6px 8px; border-radius: 3px;
      border: 1px solid var(--p-line); background: var(--p-code-bg);
      font-size: 10.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-all;
      max-height: 220px; overflow: auto; font-family: var(--p-mono); color: var(--p-text);
    }
    .tool-approval-label { font-size: 10px; font-weight: 700; letter-spacing: .04em; color: var(--p-text-faint); margin-top: 5px; }
    .agent-content { min-height: 1px; }
    .tool-approval-actions { display: flex; gap: 7px; flex-wrap:wrap; margin-top: 10px; }
    .tool-approval button {
      min-height: 30px; border: 1px solid var(--p-line-strong); border-radius: 5px;
      padding: 0 11px; cursor: pointer; font-size: 11.5px; font-weight: 600;
      font-family: inherit; background: var(--p-bg); color: var(--p-text-sub);
      transition: background var(--p-dur) var(--p-ease), color var(--p-dur) var(--p-ease), border-color var(--p-dur) var(--p-ease);
    }
    .tool-approval button:focus-visible { outline: 2px solid var(--p-accent); outline-offset: 2px; }
    .tool-approve { color: #fffdf8; background: var(--p-accent); border-color: var(--p-accent) !important; }
    .tool-approve:hover { background: var(--p-accent-hover); border-color: var(--p-accent-hover) !important; }
    .tool-approve-session { color: var(--p-success); border-color: var(--p-success) !important; background: transparent; }
    .tool-approve-session:hover { background: rgba(46, 106, 78, .1); }
    .tool-reject { color: var(--p-text-faint); background: transparent; border-color: var(--p-line-strong) !important; }
    .tool-reject:hover { color: var(--p-danger); border-color: var(--p-danger) !important; }
    .approval-settings { position:relative; padding:8px 10px; border-bottom:1px solid var(--p-line); }
    .panel.approval-open { overflow:visible; }
    .approval-settings-toggle {
      width:100%; min-height:34px; text-align:left; color: var(--p-text-sub);
      background:transparent; border:0; font-size:11.5px; cursor:pointer; padding:5px 2px;
      font-family: inherit; display: flex; align-items: center; gap: 6px;
    }
    .approval-settings-toggle:hover { color: var(--p-text); }
    .approval-settings-toggle span { margin-left: auto; display: inline-flex; transition: transform var(--p-dur) var(--p-ease); }
    .approval-settings-popover {
      position:absolute; left:10px; right:10px; bottom:40px; z-index:20; padding:10px;
      border:1px solid var(--p-line-strong); border-radius:6px; background: var(--p-bg);
      box-shadow: var(--p-float); max-height:56vh; overflow:auto;
    }
    .approval-settings-caption { color: var(--p-text-faint); font-size:10px; margin:6px 0 4px; }
    .approval-autopilot { display:flex; align-items:center; gap:6px; padding:4px 2px 6px; font-size:11.5px; cursor:pointer; border-bottom:1px solid var(--p-line); }
    .approval-group { margin:4px 0 2px; padding:0 0 0 8px; border-left:1px solid var(--p-line); }
    .approval-group-title { font-size:10px; font-weight:700; letter-spacing:.06em; color: var(--p-text-faint); margin:6px 0 2px; text-transform:uppercase; }
    .approval-settings-popover label.approval-item { display:block; padding:4px 2px; font-size:11.5px; cursor:pointer; }
    .approval-settings-popover label.approval-item small { color: var(--p-text-faint); font-size:10px; margin-left:3px; }
    .approval-settings-popover input { accent-color: var(--p-accent); margin-right:6px; }
    .approval-settings-popover select {
      margin-left:4px; font-size:11.5px; padding:2px 4px; border-radius:4px;
      border:1px solid var(--p-line-strong); background: var(--p-bg); color: var(--p-text); font-family:inherit;
    }
    @media (max-width: 480px) {
      .p-head { gap: 6px; padding: 8px 10px; }
      .p-head .logo { width: 16px; height: 16px; }
      .p-head .session-btn { max-width: 86px; min-height: 30px; }
      .p-foot { flex-wrap: wrap; }
      .p-foot .copy-btn { margin-left: 0; }
      .session-actions button { width: 32px; height: 32px; }
      .quick-prompt { min-height: 28px; }
    }
    /* 打印 / 导出 PDF：打印走的是**渲染**，shadow 里的悬浮球与面板会实打实印出来。
       这条规则写在 shadow 内部，因此不需要往页面 light DOM 里插任何 <style> ——
       导出产物里也就不会多出一个"扩展留下的样式标签"。
       与 lib/page/save-clean.js 的 beforeprint 摘除互为保险：任一条生效，纸面上都干净。 */
    @media print {
      :host { display: none !important; visibility: hidden !important; }
    }
`;