// 面板（Shadow DOM）的样式表。
//
// 为什么单独成模块：它是纯字符串、无任何依赖，却是 chat.js 里最长的一段
//（357 行），把样式与逻辑混在一个文件里会让「面板行为」极难通读。
// 抽出来后 chat.js 只保留逻辑，样式集中在此便于整体调整与对照深色主题规则。

export const PANEL_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; }
    .bubble {
      position: fixed; z-index: 2147483647;
      display: flex; align-items: center; gap: 6px;
      background: #4a90d9; color: #fff; border-radius: 20px;
      padding: 6px 12px; cursor: pointer; user-select: none;
      font-size: 13px; box-shadow: 0 4px 14px rgba(0,0,0,.25);
      transition: background .15s, transform .15s;
      animation: kb-pop .18s ease;
    }
    @keyframes kb-pop { from { transform: scale(.8); opacity: 0; } to { transform: scale(1); opacity: 1; } }
    .bubble:hover { background: #3a7cc4; transform: translateY(-1px); }
    .bubble .dot { width: 6px; height: 6px; border-radius: 50%; background: #fff; animation: kb-blink 1.2s infinite; }
    @keyframes kb-blink { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
    .panel {
      position: fixed; z-index: 2147483647;
      width: 640px; height: auto; min-width: 280px; min-height: 320px;
      max-width: calc(100vw - 24px); max-height: calc(100vh - 24px);
      background: #fff; border-radius: 14px; box-shadow: 0 12px 40px rgba(0,0,0,.28);
      display: flex; flex-direction: column; overflow: hidden;
      animation: kb-pop .18s ease;
      /* 左右边缘留给 resize 手柄的抓取宽度。
         手柄是绝对定位 + z-index:5，压在正文之上；而滚动条也贴在容器右边缘，
         两者会完全重叠 —— 结果就是滚动条点不动、也拖不动（mousedown 被 resize 抢走）。
         所以滚动容器必须按同样宽度右缩，让滚动条落在手柄左侧。
         取值同时被 .resize-handle.left/.right 与 .p-body 使用，避免两处各写一个数字后漂移。 */
      --rf-edge: 10px;
    }
    .panel.docked { max-height: calc(100vh - 24px); }
    @media (max-width: 640px) { .panel.docked { max-height: calc(100vh - 24px); } }
    .resize-handle {
      position: absolute; right: 0; bottom: 0;
      width: 18px; height: 18px; cursor: nwse-resize;
      user-select: none; touch-action: none; z-index: 5;
    }
    .resize-handle.top-left { right:auto; bottom:auto; left:0; top:0; cursor:nwse-resize; }
    .resize-handle.top-left::after { right:auto; bottom:auto; left:4px; top:4px; border-right:0; border-bottom:0; border-left:2px solid #c0c4cc; border-top:2px solid #c0c4cc; border-radius:3px 0 0 0; }
    .resize-handle.top { left:18px; right:18px; top:0; bottom:auto; width:auto; height:10px; cursor:ns-resize; }
    .resize-handle.bottom { left:18px; right:18px; top:auto; bottom:0; width:auto; height:10px; cursor:ns-resize; }
    .resize-handle.left { left:0; top:18px; right:auto; bottom:18px; width:var(--rf-edge); height:auto; cursor:ew-resize; }
    .resize-handle.right { right:0; left:auto; top:18px; bottom:18px; width:var(--rf-edge); height:auto; cursor:ew-resize; }
    .resize-handle.top-right { left:auto; right:0; top:0; bottom:auto; cursor:nesw-resize; }
    .resize-handle.bottom-left { left:0; right:auto; top:auto; bottom:0; cursor:nesw-resize; }
    .resize-handle::after {
      content: ''; position: absolute; right: 4px; bottom: 4px;
      width: 9px; height: 9px;
      border-right: 2px solid #c0c4cc; border-bottom: 2px solid #c0c4cc;
      border-radius: 0 0 3px 0;
      transition: border-color .15s;
      opacity: 0;
    }
    .resize-handle:hover::after { border-color: transparent; }
    .panel.dark { background: #26292e; }
    .p-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: #f5f6f8; border-bottom: 1px solid #e2e5ea; cursor: grab; }
    .p-head:active { cursor: grabbing; }
    .panel.dark .p-head { background: #2f3339; border-color: #3a3f46; }
    .p-head .logo { width: 20px; height: 20px; object-fit: contain; flex-shrink: 0; }
    .p-head .title { font-size: 14px; font-weight: 600; color: #333; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .panel.dark .p-head .title { color: #e3e5e8; }
    .p-head .usage { font-size: 11px; color: #98a0aa; margin-left: auto; margin-right: 6px; white-space: nowrap; }
    .p-head .close { border: none; background: none; color: #6b7280; font-size: 16px; cursor: pointer; line-height: 1; padding: 2px 4px; border-radius: 4px; min-width: 32px; min-height: 32px; }
    .p-head .close:hover { color: #e74c3c; background: rgba(0,0,0,.05); }
/* 交接标识芯片：点一下把本次会话打包并复制可直接粘给 AI 的指令 */
.p-head .handoff { border: 1px solid #d5d9e0; background: #fff; color: #55606e; font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; cursor: pointer; padding: 2px 7px; border-radius: 999px; white-space: nowrap; margin-right: 4px; }
.p-head .handoff:hover { border-color: #4a90d9; color: #4a90d9; }
.p-head .handoff.copied { border-color: #27ae60; color: #27ae60; }
.panel.dark .p-head .handoff { background: #262a30; border-color: #3a3f46; color: #b6bcc6; }
.panel.dark .p-head .handoff:hover { border-color: #4a90d9; color: #4a90d9; }
    .p-head .session-btn { border: 1px solid #d5d9e0; background: #fff; color: #4d5968; font-size: 11px; cursor: pointer; padding: 3px 8px; border-radius: 999px; white-space: nowrap; max-width: 112px; overflow: hidden; text-overflow: ellipsis; }
    .p-head .session-btn:hover { border-color: #4a90d9; color: #4a90d9; }
    .panel.dark .p-head .session-btn { background: #262a30; border-color: #3a3f46; color: #c4cad3; }
    .session-menu { position: absolute; z-index: 30; top: 46px; right: 10px; width: min(340px, calc(100% - 20px)); max-height: min(470px, calc(100vh - 110px)); display: flex; flex-direction: column; background: #fff; border: 1px solid #dfe3e9; border-radius: 11px; box-shadow: 0 12px 34px rgba(22,34,51,.22); overflow: hidden; }
    .session-menu[hidden] { display: none; }
    .panel.dark .session-menu { background: #2a2e34; border-color: #444a53; box-shadow: 0 14px 38px rgba(0,0,0,.45); }
    .session-menu-head { display: flex; align-items: center; justify-content: space-between; padding: 9px 11px; font-size: 11px; font-weight: 600; letter-spacing: .04em; color: #7d8794; border-bottom: 1px solid #edf0f4; }
    .panel.dark .session-menu-head { color: #aab2bd; border-color: #3b4149; }
    .session-menu-close { border: none; background: none; color: #9aa3ae; cursor: pointer; font-size: 13px; padding: 2px 4px; border-radius: 4px; }
    .session-menu-close:hover { background: rgba(0,0,0,.05); color: #596574; }
    .session-list { overflow-y: auto; padding: 4px; min-height: 0; }
    .session-item { display: flex; align-items: stretch; border-radius: 8px; border: 1px solid transparent; }
    .session-item:hover { background: #f5f8fc; }
    .session-item.active { background: #eef5ff; border-color: #cfe3fb; }
    .session-item.running .session-title { color: #b45309; }
    .panel.dark .session-item:hover { background: #323840; }
    .panel.dark .session-item.active { background: #25364a; border-color: #36597f; }
    .session-main { flex: 1; min-width: 0; border: none; background: none; text-align: left; padding: 7px 6px 7px 9px; cursor: pointer; color: #374151; display: flex; flex-direction: column; gap: 2px; }
    .panel.dark .session-main { color: #e1e5eb; }
    .session-title { font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 230px; }
    .session-meta { font-size: 11px; color: #66707d; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .panel.dark .session-meta { color: #99a3af; }
    .session-actions { display: flex; align-items: center; gap: 1px; padding-right: 4px; opacity: .72; transition: opacity .12s; }
    .session-item:hover .session-actions, .session-item.active .session-actions, .session-item:focus-within .session-actions { opacity: 1; }
    .session-actions button { border: none; background: none; color: #66707d; cursor: pointer; width: 30px; height: 30px; border-radius: 6px; font-size: 13px; padding: 0; }
    .session-actions button:hover { background: rgba(74,144,217,.12); color: #2f74b8; }
    .session-actions button[data-session-action="delete"]:hover { background: rgba(231,76,60,.12); color: #c0392b; }
    .panel.dark .session-actions button { color: #aab2bc; }
    .session-empty { padding: 18px 10px; text-align: center; color: #98a0aa; font-size: 12px; }
    .session-new { border: none; border-top: 1px solid #edf0f4; background: #fafbfc; color: #397cc0; padding: 9px 12px; text-align: left; font-size: 12px; font-weight: 600; cursor: pointer; }
    .session-new:hover { background: #f0f6fd; }
    .panel.dark .session-new { background: #25292f; border-color: #3b4149; color: #72abe2; }
    .panel.dark .session-new:hover { background: #2f3944; }
    .session-dialog-backdrop { position: absolute; inset: 0; z-index: 60; background: rgba(26,32,40,.34); display: flex; align-items: center; justify-content: center; padding: 18px; }
    .session-dialog { width: min(390px, 100%); background: #fff; border-radius: 12px; box-shadow: 0 20px 50px rgba(0,0,0,.3); padding: 16px; }
    .panel.dark .session-dialog { background: #2c3036; color: #e4e7ec; }
    .session-dialog-title { font-size: 14px; font-weight: 700; margin-bottom: 7px; }
    .session-dialog-message { font-size: 12px; line-height: 1.6; color: #66707d; margin-bottom: 11px; word-break: break-word; }
    .panel.dark .session-dialog-message { color: #b1b9c3; }
    .session-dialog-input { width: 100%; border: 1px solid #cfd5dd; border-radius: 7px; padding: 7px 9px; font-size: 13px; outline: none; margin-bottom: 13px; background: #fff; color: #333; }
    .session-dialog-input:focus { border-color: #4a90d9; box-shadow: 0 0 0 3px rgba(74,144,217,.14); }
    .panel.dark .session-dialog-input { background: #22262b; color: #e4e7ec; border-color: #49505a; }
    .session-dialog-actions { display: flex; justify-content: flex-end; gap: 7px; flex-wrap: wrap; }
    .session-dialog-actions button { border: 1px solid #d8dde4; background: #fff; color: #596575; border-radius: 7px; padding: 6px 11px; font-size: 12px; cursor: pointer; }
    .session-dialog-actions button:hover { border-color: #4a90d9; color: #3b79b8; }
    .session-dialog-actions .primary { background: #4a90d9; border-color: #4a90d9; color: #fff; }
    .session-dialog-actions .primary:hover { background: #3b80c7; color: #fff; }
    .session-dialog-actions .danger { background: #e74c3c; border-color: #e74c3c; color: #fff; }
    .session-dialog-actions .danger:hover { background: #cf3e2f; color: #fff; }
    .session-dialog-actions .session-dialog-extra { margin-right: auto; color: #397cc0; }
    .panel.dark .session-dialog-actions button { background: #343a42; border-color: #4a505a; color: #d9dee5; }
    .panel.dark .session-dialog-actions .primary { background: #4a90d9; border-color: #4a90d9; color: #fff; }
    .panel.dark .session-dialog-actions .danger { background: #d94b3e; border-color: #d94b3e; color: #fff; }
    .p-text {
      margin: 6px 12px 0; padding: 4px 10px; font-size: 12px; color: #888; line-height: 1.5;
      max-height: 30px; overflow: auto; border-left: 2px solid #e2e5ea; word-break: break-word;
      user-select: none; flex-shrink: 0;
    }
    .panel.dark .p-text { color: #9aa0a8; border-color: #3a3f46; }
    /* margin-right 是 --rf-edge：把滚动条推到右侧 resize 手柄的左边。
       少了这一句，手柄（绝对定位 + z-index:5）会压住滚动条，滚动条就点不动、拖不动。 */
    .p-body { padding: 10px 12px; margin-right: var(--rf-edge); overflow-y: auto; flex: 1 1 auto; font-size: 13px; line-height: 1.7; color: #333; word-break: break-word; min-height: 0; scrollbar-width: thin; scrollbar-color: #d5d9e0 transparent; }
    .p-body::-webkit-scrollbar { width: 8px; }
    .p-body::-webkit-scrollbar-thumb { background: #d5d9e0; border-radius: 999px; }
    .p-body::-webkit-scrollbar-thumb:hover { background: #b8bec6; }
    .p-body::-webkit-scrollbar-track { background: transparent; }
    .panel.dark .p-body { color: #e3e5e8; scrollbar-color: #3a3f46 transparent; }
    .panel.dark .p-body::-webkit-scrollbar-thumb { background: #3a3f46; }
    .panel.dark .p-body::-webkit-scrollbar-thumb:hover { background: #4a5058; }
    .p-body.loading { color: #999; }
    .panel.dark .p-body.loading { color: #9aa0a8; }
    .p-body.error { color: #e74c3c; }
    .msg { margin-bottom: 14px; max-width: 100%; }
    .msg.user {
      background: linear-gradient(135deg, #4a90d9, #63a0e2); color: #fff;
      border-radius: 12px 12px 4px 12px;
      padding: 8px 14px; margin-left: auto; white-space: pre-wrap;
      width: fit-content;
      box-shadow: 0 2px 8px rgba(74,144,217,.22);
    }
    .msg.ai { background: transparent; padding: 0 2px; margin-right: 6px; }
    /* 用户气泡里「这条消息带上了哪些拾取元素」那一行。
       它必须**留在气泡内**：那是这条消息的上下文，不是提示条 ——
       放到气泡外就又会变成"发送后消失的临时状态"。 */
    .user-picks { display: block; margin-top: 4px; font-size: 11.5px; line-height: 1.5; color: rgba(255,255,255,.82); word-break: break-all; }
    .msg.ai .typing { color: #999; }
    .panel.dark .msg.ai .typing { color: #9aa0a8; }
    .typing { display: inline-flex; gap: 4px; align-items: center; }
    .typing span { width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: kb-bounce 1.2s infinite; }
    .typing span:nth-child(2) { animation-delay: .15s; }
    .typing span:nth-child(3) { animation-delay: .3s; }
    @keyframes kb-bounce { 0%,60%,100% { transform: translateY(0); opacity: .4; } 30% { transform: translateY(-4px); opacity: 1; } }
    /* ---- 思考记录（思维链）----
       只有**推理模型**会产出内容（deepseek-reasoner）；deepseek-chat 下这一块不会出现，
       用户看到的仍是上面那三个点 + FAB 呼吸动画。
       展开/收起由 data-open 控制；进行中的动画只在 data-state="running" 时跑 ——
       静止的思考记录不该继续闪，否则用户会误以为还在生成。 */
    .think-block { margin: 6px 0 8px; border-left: 2px solid rgba(74,144,217,.35); border-radius: 4px; background: rgba(74,144,217,.05); overflow: hidden; }
    .panel.dark .think-block { border-left-color: rgba(106,165,224,.45); background: rgba(106,165,224,.07); }
    .think-head { display: flex; align-items: center; gap: 6px; width: 100%; padding: 5px 8px; background: none; border: 0; cursor: pointer; font: inherit; font-size: 12px; color: #6b7c8f; text-align: left; }
    .panel.dark .think-head { color: #9aa0a8; }
    .think-head:hover { color: #4a90d9; }
    .think-label { flex: 1 1 auto; }
    .think-caret { flex: 0 0 auto; font-size: 10px; transition: transform .15s ease; }
    .think-block[data-open="true"] .think-caret { transform: rotate(180deg); }
    .think-dots { display: inline-flex; flex: 0 0 auto; gap: 3px; align-items: center; }
    .think-dots span { width: 4px; height: 4px; border-radius: 50%; background: currentColor; opacity: .45; }
    .think-block[data-state="running"] .think-dots span { opacity: 1; animation: kb-bounce 1.2s infinite; }
    .think-block[data-state="running"] .think-dots span:nth-child(2) { animation-delay: .15s; }
    .think-block[data-state="running"] .think-dots span:nth-child(3) { animation-delay: .3s; }
    /* 进行中：标签走一遍扫光，长思维链里比三个点更容易被注意到。
       ⚠ 必须用 @supports 包住：background-clip:text 不生效时 -webkit-text-fill-color:transparent
       会把**文字整个变没**（只剩一条看不见的渐变），这是宁可不动画也不能冒的险。 */
    @supports ((-webkit-background-clip: text) or (background-clip: text)) {
      .think-block[data-state="running"] .think-label {
        background: linear-gradient(90deg, currentColor 0%, #4a90d9 45%, currentColor 90%);
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
    .think-body { display: none; padding: 0 10px 8px; font-size: 12px; line-height: 1.6; color: #6b7c8f; white-space: pre-wrap; word-break: break-word; }
    .panel.dark .think-body { color: #9aa0a8; }
    .think-block[data-open="true"] .think-body { display: block; }
    .p-body h1, .p-body h2, .p-body h3, .p-body h4 { margin: 14px 0 8px; line-height: 1.4; font-weight: 700; }
    .p-body h1 { font-size: 17px; } .p-body h2 { font-size: 15.5px; } .p-body h3 { font-size: 14.5px; } .p-body h4 { font-size: 13.5px; }
    .msg.ai > :first-child { margin-top: 2px; }
    .msg.ai > :last-child { margin-bottom: 2px; }
    .p-body p { margin: 8px 0; padding: 0; background: none; border-radius: 0; }
    .p-body ul, .p-body ol { margin: 8px 0; padding-left: 22px; background: none; border-radius: 0; padding-top: 2px; padding-bottom: 2px; }
    .p-body li { margin: 4px 0; }
    .p-body li::marker { color: #4a90d9; }
    .panel.dark .p-body li::marker { color: #6aa5e0; }
    .p-body code { background: rgba(74,144,217,.1); color: #3a7cc4; border-radius: 4px; padding: 1px 6px; font-size: 12px; font-family: Consolas, "Cascadia Code", monospace; }
    .panel.dark .p-body code { background: rgba(110,168,254,.15); color: #9ecbff; }
    .code-wrap { position: relative; margin: 10px 0; border-radius: 10px; background: #171a21; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,.18); }
    .panel.dark .code-wrap { background: #14171d; border: 1px solid #2a2f38; }
    .code-head { display: flex; align-items: center; justify-content: space-between; padding: 5px 12px; background: #232833; }
    .panel.dark .code-head { background: #1d222b; }
    .code-lang { font-size: 11px; color: #8b949e; letter-spacing: .5px; text-transform: uppercase; user-select: none; font-family: Consolas, monospace; }
    .code-wrap pre { background: transparent; padding: 12px 14px; overflow-x: auto; margin: 0; }
    .code-wrap pre code { background: none; padding: 0; color: #d6dce5; font-size: 12px; line-height: 1.7; font-family: Consolas, "Cascadia Code", monospace; }
    .code-copy {
      border: none; background: none; color: #8b949e;
      border-radius: 6px; padding: 2px 8px; font-size: 11px; cursor: pointer;
      font-family: inherit; transition: color .15s, background .15s; line-height: 1.6;
    }
    .code-copy:hover { color: #fff; background: rgba(255,255,255,.08); }
    .code-copy.copied { color: #4ade80; }
    .tk-comment { color: #8b949e; font-style: italic; }
    .tk-string { color: #a5d6ff; }
    .tk-number { color: #79c0ff; }
    .tk-keyword { color: #ff7b72; font-weight: 600; }
    .tk-type { color: #d2a8ff; }
    .tk-fn { color: #d2a8ff; }
    .p-body blockquote {
      background: var(--note-bg, #f2f4f7); border-left: 3px solid #4a90d9;
      padding: 8px 12px; color: #666; margin: 10px 0; border-radius: 0 8px 8px 0;
    }
    .panel.dark .p-body blockquote { background: #2a2e34; color: #b8bec6; }
    .p-body a { color: #4a90d9; text-decoration: none; }
    .p-body a:hover { text-decoration: underline; }
    .p-body strong { font-weight: 700; }
    .p-body hr { border: none; border-top: 1px solid var(--border, #e2e5ea); margin: 14px 0; }
    .panel.dark .p-body hr { border-color: #3a3f46; }
    .md-table-wrap { margin: 10px 0; overflow-x: auto; border: 1px solid var(--border, #d5d9e0); border-radius: 8px; }
    .p-body table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
    .p-body th, .p-body td { padding: 6px 12px; border-bottom: 1px solid var(--border, #e2e5ea); text-align: left; vertical-align: top; }
    .p-body th { background: #f2f4f7; font-weight: 600; }
    .p-body tbody tr:nth-child(even) { background: rgba(0,0,0,.025); }
    .p-body tr:last-child td { border-bottom: none; }
    .panel.dark .md-table-wrap { border-color: #3a3f46; }
    .panel.dark .p-body th { background: #2a2e34; }
    .panel.dark .p-body th, .panel.dark .p-body td { border-color: #3a3f46; }
    .panel.dark .p-body tbody tr:nth-child(even) { background: rgba(255,255,255,.03); }
    .stream-cursor { display: inline-block; width: 7px; height: 13px; margin-left: 3px; vertical-align: -2px; border-radius: 1.5px; background: #4a90d9; animation: kb-cursor .9s steps(2, start) infinite; }
    @keyframes kb-cursor { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
    .msg-actions { display: flex; gap: 2px; margin-top: 6px; opacity: 0; transition: opacity .15s; }
    .msg.ai:hover .msg-actions, .msg-actions:hover { opacity: 1; }
    .msg-actions button {
      border: none; background: none; color: #98a0aa; font-size: 11.5px; cursor: pointer;
      padding: 2px 8px; border-radius: 6px; font-family: inherit;
      display: inline-flex; align-items: center; gap: 4px; transition: all .15s;
    }
    .msg-actions button:hover { background: rgba(0,0,0,.06); color: #4a90d9; }
    .panel.dark .msg-actions button:hover { background: rgba(255,255,255,.08); color: #6aa5e0; }
    .stopped-note { margin-top: 6px; font-size: 11.5px; color: #98a0aa; user-select: none; }
    .p-foot { display: flex; gap: 8px; padding: 8px 12px; border-top: 1px solid #e2e5ea; }
    .panel.dark .p-foot { border-color: #3a3f46; }
    .p-foot button { border: 1px solid #e2e5ea; background: #fff; color: #555; border-radius: 8px; padding: 6px 12px; min-height: 32px; font-size: 12px; cursor: pointer; transition: all .15s; }
    .panel.dark .p-foot button { background: #26292e; border-color: #3a3f46; color: #ccc; }
    .p-foot button:hover { border-color: #4a90d9; color: #4a90d9; }
    .p-foot .spacer { flex: 1; }
    .p-foot .copy-btn { margin-left: auto; }
    /* 第二个导出按钮（导出完整）紧挨着上一个：两个都吃 margin-left:auto 的话，
       自动外边距会在它们之间也撑开一段，页脚变成「clear …… 导出记录 …… 导出完整 停止」。 */
    .p-foot .copy-btn + .copy-btn { margin-left: 6px; }
    .p-foot .stop-btn { border-color: #e74c3c; color: #e74c3c; font-weight: 600; }
    .p-foot .stop-btn:hover { border-color: #e74c3c; color: #fff; background: #e74c3c; }
    .panel.dark .p-foot .stop-btn { border-color: #e74c3c; color: #e74c3c; }
    .panel.dark .p-foot .stop-btn:hover { color: #fff; background: #e74c3c; }
    .cmd-area { padding: 8px 12px; border-top: 1px solid #e2e5ea; flex-shrink: 0; }
    .cmd-box { display: flex; gap: 6px; align-items: stretch; }
    .panel.dark .cmd-area { border-color: #3a3f46; }
    .cmd-input {
      flex: 1; resize: none; border: 1px solid #e2e5ea; border-radius: 8px;
      padding: 6px 10px; font-size: 13px; font-family: inherit; outline: none;
      background: #fff; color: #333; min-height: 34px; max-height: 120px; line-height: 1.5;
    }
    .panel.dark .cmd-input { background: #26292e; border-color: #3a3f46; color: #e3e5e8; }
    .cmd-input:focus { border-color: #4a90d9; box-shadow: 0 0 0 3px rgba(74,144,217,.15); }
    .cmd-send {
      border: 1px solid #4a90d9; background: #4a90d9; color: #fff;
      border-radius: 8px; padding: 0 14px; font-size: 13px; cursor: pointer; font-family: inherit;
      transition: background .15s; flex-shrink: 0; min-height: 36px;
    }
    .cmd-send:hover { background: #3a7cc4; }
    .cmd-send:disabled { opacity: .5; cursor: not-allowed; }
    .quick-prompts { display: flex; gap: 6px; flex-wrap: wrap; align-items: flex-start; padding: 0 0 3px; margin: 0 0 7px; }
    .quick-prompt { flex: 0 1 auto; min-width: 0; max-width: 100%; border: 1px solid #c8d9ec; background: #f5f9fd; color: #3d6f9e; border-radius: 12px; padding: 5px 10px; min-height: 30px; font-size: 12px; line-height: 1.35; cursor: pointer; white-space: normal; overflow-wrap: anywhere; text-align: left; }
    .quick-prompt:hover { background: #e5f0fb; }
    .panel.dark .quick-prompt { background: #293746; border-color: #3d5570; color: #9bc5eb; }
    .pick-bar { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 7px; }
    .pick-chip { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: #3d6f9e; background: #eef5fd; border: 1px solid #c8d9ec; border-radius: 12px; padding: 3px 8px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .panel.dark .pick-chip { background: #293746; border-color: #3d5570; color: #9bc5eb; }
    .pick-chip .pick-clear { border: none; background: none; color: inherit; cursor: pointer; font-size: 12px; padding: 0 0 0 2px; font-family: inherit; }
    .pick-chip .pick-chip-text { overflow: hidden; text-overflow: ellipsis; max-width: 220px; }
    .pick-chip .pick-copy { border: none; background: none; color: inherit; cursor: pointer; font-size: 12px; padding: 0 2px; font-family: inherit; opacity: .75; }
    .pick-chip .pick-copy:hover { opacity: 1; }
    .pick-clear-all { border: 1px solid #c8d9ec; background: #f5f9fd; color: #3d6f9e; border-radius: 12px; padding: 3px 8px; font-size: 11px; cursor: pointer; font-family: inherit; }
    .panel.dark .pick-clear-all { background: #293746; border-color: #3d5570; color: #9bc5eb; }
    .cmd-pick { display: inline-flex; align-items: center; justify-content: center; border: 1px solid #c8d9ec; background: #f5f9fd; color: #3d6f9e; border-radius: 8px; padding: 0 9px; min-width: 36px; min-height: 36px; font-size: 12px; cursor: pointer; flex-shrink: 0; font-family: inherit; white-space: nowrap; }
    .cmd-pick:hover { background: #e5f0fb; }
    .cmd-pick.active { background: #4a90d9; color: #fff; border-color: #4a90d9; }
    .panel.dark .cmd-pick { background: #293746; border-color: #3d5570; color: #9bc5eb; }
    .panel.dark .cmd-pick.active { background: #4a90d9; color: #fff; }
    .suggestion-options { display: flex; flex-wrap: wrap; gap: 5px; margin: 8px 0 2px; }
    .suggestion-title { width: 100%; font-size: 11px; color: #6b7280; }
    .panel.dark .suggestion-title { color: #9aa7b5; }
    .suggestion-option { border: 1px solid #4a90d9; color: #4a90d9; background: none; border-radius: 12px; padding: 3px 10px; font-size: 11px; cursor: pointer; }
    .suggestion-option:hover { background: #e5f0fb; }
    .panel.dark .suggestion-option { background: #293746; border-color: #5b86b8; color: #9bc5eb; }
    .panel.dark .suggestion-option:hover { background: #34465c; }
    .fab {
      position: fixed; right: 16px; top: 38%; z-index: 2147483646;
      width: 52px; height: 52px; border: 1px solid rgba(255,255,255,.45); border-radius: 50%;
      background: linear-gradient(145deg, #5ba0e5 0%, #3d7fc4 100%);
      color: #fff; display: flex; align-items: center; justify-content: center;
      font-size: 14px; font-weight: 700; letter-spacing: .4px; cursor: grab;
      box-shadow: 0 8px 22px rgba(45,105,165,.36), inset 0 1px 1px rgba(255,255,255,.35);
      transition: transform .18s ease, box-shadow .18s ease, filter .18s ease;
      user-select: none; touch-action: none;
    }
    .user-turn { width: fit-content; max-width: 96%; margin: 0 0 14px auto; }
    .user-turn .msg { margin-bottom: 3px; }
    .user-actions { display: flex; justify-content: flex-end; align-items: center; opacity: 0; transition: opacity .15s; }
    .user-turn:hover .user-actions, .user-actions:hover { opacity: 1; }
    .user-actions button { border: none; background: none; color: #98a0aa; font-size: 11.5px; cursor: pointer; padding: 2px 7px; border-radius: 6px; font-family: inherit; }
    .user-actions button:hover { background: rgba(0,0,0,.06); color: #4a90d9; }
    .panel.dark .user-actions button:hover { background: rgba(255,255,255,.08); color: #6aa5e0; }
    @media (hover: none) { .msg-actions, .user-actions { opacity: 1; } }
    .fab::before { content: ''; position: absolute; inset: 5px; border: 1px solid rgba(255,255,255,.2); border-radius: 50%; pointer-events: none; }
    .fab::after { content: ''; position: absolute; right: -2px; bottom: 2px; width: 10px; height: 10px; border-radius: 50%; background: #52d38a; border: 2px solid #fff; }
    .fab:hover { transform: translateY(-2px) scale(1.06); filter: saturate(1.08); box-shadow: 0 11px 26px rgba(45,105,165,.46), inset 0 1px 1px rgba(255,255,255,.4); }
    .fab:active { transform: translateY(0) scale(.97); }
    .fab.dragging { cursor: grabbing; transform: scale(.98); transition: none; }
    .fab:focus-visible { outline: 3px solid rgba(91,160,229,.45); outline-offset: 3px; }
    .fab img { width: 37px; height: 37px; object-fit: contain; position: relative; z-index: 1; }
    .fab.hidden { display: none; }
    .fab.thinking { animation: fab-pulse 1.2s ease-in-out infinite; }
    @keyframes fab-pulse { 0%,100% { box-shadow: 0 8px 22px rgba(45,105,165,.36), 0 0 0 0 rgba(82,211,138,.35); } 50% { box-shadow: 0 10px 26px rgba(45,105,165,.48), 0 0 0 7px rgba(82,211,138,0); } }
    @media (max-width: 600px) { .fab { right: 12px; width: 46px; height: 46px; font-size: 13px; } }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; scroll-behavior: auto !important; }
    }
    .cite-badge {
      display: inline-flex; align-items: center; gap: 3px;
      background: #eaf3fc; color: #4a90d9; border: 1px solid #b8d4f0;
      border-radius: 10px; padding: 0 7px; margin: 0 2px;
      font-size: 11px; line-height: 1.7; cursor: pointer; user-select: none;
      vertical-align: baseline; transition: all .15s; font-family: inherit;
      max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .cite-badge:hover { background: #4a90d9; color: #fff; border-color: #4a90d9; }
    .cite-badge .cite-idx { font-weight: 700; flex-shrink: 0; }
    .panel.dark .cite-badge { background: #2b3644; border-color: #3d5570; color: #7db4e8; }
    .panel.dark .cite-badge:hover { background: #4a90d9; border-color: #4a90d9; color: #fff; }
    .cite-sources {
      margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--border, #d5d9e0);
      display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
    }
    .cite-sources .cite-label { font-size: 11px; color: #999; margin-right: 2px; }
    .panel.dark .cite-sources { border-color: #3a3f46; }
    .panel.dark .cite-sources .cite-label { color: #8b949e; }
    .agent-steps { display: flex; flex-direction: column; gap: 4px; margin: 2px 0 8px; }
    .agent-flow { display: flex; flex-direction: column; gap: 4px; margin: 2px 0 8px; }
    .agent-plan { margin: 2px 0 8px; padding: 8px 10px; border: 1px solid #dbe6f3; border-radius: 10px; background: #f7faff; }
    .panel.dark .agent-plan { background: #232a33; border-color: #3a4654; }
    .agent-plan-title { font-size: 11px; font-weight: 700; color: #4a90d9; margin-bottom: 5px; }
    .agent-plan-item { font-size: 12px; line-height: 1.6; color: #6b7280; }
    .panel.dark .agent-plan-item { color: #9aa6b3; }
    .agent-plan-item.done { color: #16a34a; text-decoration: line-through; opacity: .8; }
    .agent-plan-item.in_progress { color: #2563eb; font-weight: 600; }
    .panel.dark .agent-plan-item.done { color: #4ade80; }
    .panel.dark .agent-plan-item.in_progress { color: #7db4e8; }
    /* 执行计划条：位于**底部控件区的第一格**（快捷指令之上、对话之下）。
       位置试过四轮才对：贴助手消息开头会随对话滚走；贴对话区顶部会压住内容
       （计划是过程、对话是内容，过程不该占内容区最顶上的版面）；紧贴输入框时
       会和审批 / 快捷指令 / 自动批准 / 拾取栏挤在一起，而那一格里只有输入框属于「输入」。
       现在它在对话之外、又和用户操作的那一整块在一起。

       **刻意不设 max-height / overflow-y**：限高加内层滚动条会把计划条变成一个小滚动框，
       既难看又要二次滚动。步骤过多改为「收成一行 / 点击展开全部」——
       展开时不设高度上限，因此任何情况下都不会出现内层滚动条。 */
    .agent-plan-bar {
      margin: 0 0 8px;
      box-shadow: 0 1px 3px rgba(15, 40, 80, .06);
    }
    .agent-plan-bar .agent-plan-title { display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; }
    .agent-plan-bar .agent-plan-title:hover { color: #2f6fb5; }
    .agent-plan-bar .agent-plan-title::before {
      content: ''; width: 6px; height: 6px; border-radius: 50%; background: #4a90d9; flex: none;
    }
    /* 收起态：一行标题，列表整块不渲染。 */
    .agent-plan-bar.collapsed { padding: 6px 10px; }
    .agent-plan-bar.collapsed .agent-plan-title { margin-bottom: 0; }
    .agent-plan-bar.collapsed .agent-plan-items { display: none; }
    .agent-step {
      font-size: 11.5px; line-height: 1.5; color: #7a8694;
      background: rgba(74,144,217,.08); border-left: 2px solid #4a90d9;
      padding: 4px 8px; border-radius: 0 6px 6px 0; word-break: break-word;
    }
    .agent-step.verify-final { margin-top: 8px; }
    .panel.dark .agent-step { background: rgba(110,168,254,.12); color: #9aa6b3; }
    .agent-tool { font-weight: 600; color: #4a90d9; }
    .panel.dark .agent-tool { color: #7db4e8; }
    .agent-tool-arg { color: inherit; opacity: .85; }
    /* 工具步骤可展开：args 与 result 本就存在 parts 里却从不渲染，
       用户只能开 DevTools 才能知道「它到底读到了什么」。 */
    .agent-step > summary { cursor: pointer; list-style: none; display: flex; gap: 4px; align-items: baseline; outline: none; }
    .agent-step > summary::-webkit-details-marker { display: none; }
    .agent-step > summary::before { content: '▸'; font-size: 9px; opacity: .7; flex-shrink: 0; }
    .agent-step[open] > summary::before { content: '▾'; }
    .agent-step > summary:focus-visible { outline: 2px solid #4a90d9; outline-offset: 1px; border-radius: 4px; }
    .agent-step-detail { margin: 5px 0 1px; padding-top: 5px; border-top: 1px dashed rgba(0,0,0,.14); }
    .panel.dark .agent-step-detail { border-color: rgba(255,255,255,.14); }
    .agent-step-label { font-size: 10.5px; font-weight: 700; opacity: .75; margin: 3px 0 2px; }
    .agent-step-pre { margin: 0; padding: 5px 7px; border-radius: 6px; background: rgba(0,0,0,.05); font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow: auto; }
    .panel.dark .agent-step-pre { background: rgba(0,0,0,.28); }
    /* 截图：给用户的可视证据（模型看不到图，所以只作展示） */
    .agent-shot { margin: 6px 0; }
    .agent-shot img { display: block; max-width: 100%; max-height: 190px; border: 1px solid #d7dde5; border-radius: 8px; cursor: zoom-in; background: #fff; }
    .panel.dark .agent-shot img { border-color: #3a3f46; }
    .agent-shot-cap { display: block; margin-top: 3px; font-size: 11px; color: #98a0aa; }
    .agent-shot.gone { font-size: 11.5px; color: #98a0aa; padding: 3px 6px; border: 1px dashed #d7dde5; border-radius: 6px; }
    .panel.dark .agent-shot.gone { border-color: #3a3f46; }
    .shot-lightbox { position: absolute; inset: 0; background: rgba(0,0,0,.82); z-index: 30; display: flex; align-items: center; justify-content: center; padding: 12px; cursor: zoom-out; }
    .shot-lightbox img { max-width: 100%; max-height: 100%; border-radius: 6px; }
    /* 进度与耗时：长任务不再黑箱 */
    .p-progress { display: none; align-items: center; gap: 8px; padding: 5px 14px; font-size: 11.5px; color: #6b7280; background: #f7faff; border-bottom: 1px solid #e2e5ea; flex-shrink: 0; }
    .p-progress.on { display: flex; }
    .panel.dark .p-progress { background: #232a33; border-color: #3a3f46; color: #9aa6b3; }
    .p-progress .pp-dot { width: 6px; height: 6px; border-radius: 50%; background: #4a90d9; animation: kb-blink 1.2s infinite; flex-shrink: 0; }
    .p-progress .pp-msg { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .p-progress .pp-time { font-variant-numeric: tabular-nums; opacity: .85; flex-shrink: 0; }
    /* 主题切换 */
    .p-head .theme { border: 1px solid transparent; background: none; color: #98a0aa; cursor: pointer; font-size: 13px; line-height: 1; padding: 2px 5px; border-radius: 6px; font-family: inherit; transition: all .15s; }
    .p-head .theme:hover { background: rgba(0,0,0,.06); color: #4a90d9; }
    .panel.dark .p-head .theme:hover { background: rgba(255,255,255,.08); color: #6aa5e0; }
    /* 高风险工具审批：给完整代码而不是截断到 400 字符 */
    .tool-approval-code { margin: 4px 0 0; padding: 6px 8px; border-radius: 6px; background: rgba(0,0,0,.06); font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-all; max-height: 220px; overflow: auto; }
    .panel.dark .tool-approval-code { background: rgba(0,0,0,.3); }
    .tool-approval-label { font-size: 10.5px; font-weight: 700; opacity: .8; margin-top: 5px; }
    .agent-content { min-height: 1px; }
    .tool-approval { margin: 10px 0; padding: 12px; border: 1px solid #f0b35b; border-radius: 12px; background: #fffaf0; font-size: 12px; color: #5f461d; box-shadow: 0 3px 12px rgba(112,76,20,.08); }
    .tool-approval-title { display:flex; align-items:center; gap:7px; font-weight: 700; font-size: 13px; margin-bottom: 7px; color:#4b3514; }
    .tool-approval-title::before { content:'!'; display:grid; place-items:center; width:20px; height:20px; border-radius:50%; background:#f59e0b; color:#fff; font-size:12px; }
    .tool-approval-summary { margin-bottom: 9px; line-height:1.55; }
    .tool-approval-tool { display:inline-flex; padding:2px 7px; border-radius:5px; background:rgba(245,158,11,.14); font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:11px; }
    .tool-approval-risk { display:inline-flex; margin-left:6px; padding:2px 7px; border-radius:999px; background:#fee2e2; color:#b91c1c; font-size:10px; font-weight:600; }
    .tool-approval-detail { margin:0 0 10px; padding:7px 8px; max-height:72px; overflow:auto; border:1px solid rgba(146,101,31,.18); border-radius:7px; background:rgba(255,255,255,.58); color:#765c32; font-size:11px; word-break:break-word; }
    .tool-approval-actions { display: flex; gap: 7px; flex-wrap:wrap; }
    .tool-approval button { min-height:32px; border: 1px solid transparent; border-radius: 7px; padding: 0 10px; cursor: pointer; font-size: 11px; font-weight:600; transition:filter .15s, transform .15s; }
    .tool-approval button:hover { filter:brightness(.96); transform:translateY(-1px); }
    .tool-approval button:focus-visible { outline:2px solid #2563eb; outline-offset:2px; }
    .tool-approve { color: #fff; background: #2563eb; }
    .tool-approve-session { color: #166534; background: #dcfce7; border-color:#86efac !important; }
    .tool-reject { color: #6b7280; background: transparent; border-color:#d1d5db !important; }
    .panel.dark .tool-approval { background: #2f291c; border-color: #866323; color: #efd59a; }
    .panel.dark .tool-approval-title { color:#f7dfaa; }
    .panel.dark .tool-approval-detail { background:rgba(0,0,0,.16); border-color:#5d4b2e; color:#d9bd82; }
    .panel.dark .tool-approve-session { color:#bbf7d0; background:#163b2a; border-color:#28734b !important; }
    .panel.dark .tool-reject { color:#c5cbd3; border-color:#59616d !important; }
    .approval-settings { position:relative; padding:8px 10px; border-bottom:1px solid var(--border,#d5d9e0); }
    .panel.approval-open { overflow:visible; }
    .approval-settings-toggle { width:100%; min-height:36px; text-align:left; color:#526079; background:transparent; border:0; font-size:12px; cursor:pointer; padding:6px 2px; }
    .approval-settings-toggle span { float:right; font-size:22px; line-height:12px; }
    .approval-settings-popover { position:absolute; left:10px; right:10px; bottom:42px; z-index:20; padding:10px; border:1px solid var(--border,#d5d9e0); border-radius:9px; background:var(--panel-bg,#fff); box-shadow:0 8px 24px rgba(0,0,0,.16); max-height:56vh; overflow:auto; }
    .approval-settings-caption { color:#888; font-size:10px; margin:6px 0 4px; }
    .approval-autopilot { display:block; padding:4px 2px 6px; font-size:12px; cursor:pointer; border-bottom:1px solid var(--border,#e2e5ea); }
    .panel.dark .approval-autopilot { border-color:#3a3f46; }
    .approval-group { margin:4px 0 2px; padding:0 0 0 8px; border-left:2px solid #e2e5ea; }
    .panel.dark .approval-group { border-color:#3a3f46; }
    .approval-group-title { font-size:10.5px; font-weight:700; letter-spacing:.3px; color:#6b7280; margin:6px 0 2px; text-transform:none; }
    .panel.dark .approval-group-title { color:#9aa0a8; }
    .approval-settings-popover label.approval-item { display:block; padding:4px 2px; font-size:12px; cursor:pointer; }
    .approval-settings-popover label.approval-item small { color:#9aa0a8; font-size:10.5px; margin-left:3px; }
    .approval-settings-popover input { accent-color:#4a90d9; margin-right:6px; }
    .approval-settings-popover select { margin-left:4px; font-size:12px; padding:2px 4px; border-radius:6px; border:1px solid #d5d9e0; background:#fff; color:inherit; font-family:inherit; }
    .panel.dark .approval-settings-popover select { background:#26292e; border-color:#3a3f46; color:#e3e5e8; }
    .panel.dark .approval-settings-toggle { color:#b6c0cc; }
    .panel.dark .approval-settings-popover { background:#26292e; border-color:#3a3f46; }
    @media (max-width: 480px) {
      .p-head { gap: 6px; padding: 8px 10px; }
      .p-head .logo { width: 18px; height: 18px; }
      .p-head .session-btn { max-width: 86px; min-height: 32px; }
      .p-foot { flex-wrap: wrap; }
      .p-foot .copy-btn { margin-left: 0; }
      .session-actions button { width: 36px; height: 36px; }
      .quick-prompt { min-height: 32px; }
    }
`;
