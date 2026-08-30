// 网页端 AI 助手 UI：悬浮按钮(FAB)/划词气泡/对话面板 + Markdown 渲染 + 对话持久化
if (typeof console !== 'undefined') console.log('[RecallFlow] chat.js v4 已加载');
import { getAISettings, AI_SETTINGS_DEFAULTS } from '../shared/settings.js';

// 扩展被重新加载/停用后，旧内容脚本的 chrome.* 调用会抛 "Extension context invalidated"。
// 用它做防御性判断，避免未捕获异常刷屏。
function isExtContextAlive() {
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return false;
    chrome.runtime.getManifest();
    return true;
  } catch (e) {
    return false;
  }
}
import { extractPageText } from './page-text.js';
import { clearCiteHighlight, isPointerInCitationRange, findAndHighlightCitation } from './citation.js';

const CSS = `
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
    .resize-handle.left { left:0; top:18px; right:auto; bottom:18px; width:10px; height:auto; cursor:ew-resize; }
    .resize-handle.right { right:0; left:auto; top:18px; bottom:18px; width:10px; height:auto; cursor:ew-resize; }
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
    .p-head .title { font-size: 13px; font-weight: 600; color: #333; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .panel.dark .p-head .title { color: #e3e5e8; }
    .p-head .close { border: none; background: none; color: #999; font-size: 16px; cursor: pointer; line-height: 1; padding: 2px 4px; border-radius: 4px; }
    .p-head .close:hover { color: #e74c3c; background: rgba(0,0,0,.05); }
    .p-text {
      margin: 6px 12px 0; padding: 4px 10px; font-size: 12px; color: #888; line-height: 1.5;
      max-height: 30px; overflow: auto; border-left: 2px solid #e2e5ea; word-break: break-word;
      user-select: none; flex-shrink: 0;
    }
    .panel.dark .p-text { color: #9aa0a8; border-color: #3a3f46; }
    .p-body { padding: 10px 12px; overflow-y: auto; flex: 1 1 auto; font-size: 13px; line-height: 1.7; color: #333; word-break: break-word; min-height: 0; scrollbar-width: thin; scrollbar-color: #d5d9e0 transparent; }
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
    .msg.ai .typing { color: #999; }
    .panel.dark .msg.ai .typing { color: #9aa0a8; }
    .typing { display: inline-flex; gap: 4px; align-items: center; }
    .typing span { width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: kb-bounce 1.2s infinite; }
    .typing span:nth-child(2) { animation-delay: .15s; }
    .typing span:nth-child(3) { animation-delay: .3s; }
    @keyframes kb-bounce { 0%,60%,100% { transform: translateY(0); opacity: .4; } 30% { transform: translateY(-4px); opacity: 1; } }
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
    .p-foot button { border: 1px solid #e2e5ea; background: #fff; color: #555; border-radius: 8px; padding: 5px 12px; font-size: 12px; cursor: pointer; transition: all .15s; }
    .panel.dark .p-foot button { background: #26292e; border-color: #3a3f46; color: #ccc; }
    .p-foot button:hover { border-color: #4a90d9; color: #4a90d9; }
    .p-foot .spacer { flex: 1; }
    .p-foot .copy-btn { margin-left: auto; }
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
      transition: background .15s; flex-shrink: 0;
    }
    .cmd-send:hover { background: #3a7cc4; }
    .cmd-send:disabled { opacity: .5; cursor: not-allowed; }
    .quick-prompts { display: flex; gap: 5px; flex-wrap: wrap; margin: 0 0 7px; }
    .quick-prompt { border: 1px solid #c8d9ec; background: #f5f9fd; color: #3d6f9e; border-radius: 12px; padding: 3px 8px; font-size: 11px; cursor: pointer; }
    .quick-prompt:hover { background: #e5f0fb; }
    .panel.dark .quick-prompt { background: #293746; border-color: #3d5570; color: #9bc5eb; }
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
      font-size: 14px; font-weight: 700; letter-spacing: .4px; cursor: pointer;
      box-shadow: 0 8px 22px rgba(45,105,165,.36), inset 0 1px 1px rgba(255,255,255,.35);
      transition: transform .18s ease, box-shadow .18s ease, filter .18s ease;
      user-select: none;
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
    .fab:focus-visible { outline: 3px solid rgba(91,160,229,.45); outline-offset: 3px; }
    .fab img { width: 37px; height: 37px; object-fit: contain; position: relative; z-index: 1; }
    .fab.hidden { display: none; }
    .fab.thinking { animation: fab-pulse 1.2s ease-in-out infinite; }
    @keyframes fab-pulse { 0%,100% { box-shadow: 0 8px 22px rgba(45,105,165,.36), 0 0 0 0 rgba(82,211,138,.35); } 50% { box-shadow: 0 10px 26px rgba(45,105,165,.48), 0 0 0 7px rgba(82,211,138,0); } }
    @media (max-width: 600px) { .fab { right: 12px; width: 46px; height: 46px; font-size: 13px; } }
    @media (prefers-reduced-motion: reduce) { .fab, .bubble { animation: none !important; transition: none !important; } }
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
    .agent-step {
      font-size: 11.5px; line-height: 1.5; color: #7a8694;
      background: rgba(74,144,217,.08); border-left: 2px solid #4a90d9;
      padding: 4px 8px; border-radius: 0 6px 6px 0; word-break: break-word;
    }
    .panel.dark .agent-step { background: rgba(110,168,254,.12); color: #9aa6b3; }
    .agent-tool { font-weight: 600; color: #4a90d9; }
    .panel.dark .agent-tool { color: #7db4e8; }
    .agent-tool-arg { color: inherit; opacity: .85; }
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
    .approval-settings-toggle { width:100%; text-align:left; color:#526079; background:transparent; border:0; font-size:12px; cursor:pointer; padding:4px 2px; }
    .approval-settings-toggle span { float:right; font-size:22px; line-height:12px; }
    .approval-settings-popover { position:absolute; left:10px; right:10px; bottom:42px; z-index:20; padding:10px; border:1px solid var(--border,#d5d9e0); border-radius:9px; background:var(--panel-bg,#fff); box-shadow:0 8px 24px rgba(0,0,0,.16); }
    .approval-settings-caption { color:#888; font-size:10px; margin-bottom:6px; }
    .approval-settings-popover label { display:block; padding:6px 2px; font-size:12px; cursor:pointer; }
    .approval-settings-popover input { accent-color:#4a90d9; margin-right:6px; }
    .panel.dark .approval-settings-toggle { color:#b6c0cc; }
    .panel.dark .approval-settings-popover { background:#26292e; border-color:#3a3f46; }
  `;

let host = null;
let shadow = null;
let bubble = null;
let panel = null;
let panelBody = null;
let lastText = '';
let lastResponse = '';
let port = null;
let dragState = null;
let resizeState = null;
let pageText = '';
let panelTextEl = null;
let fab = null;
let conversation = [];
let stopBtn = null;
let streaming = false;
let pendingAcc = '';
let pendingAiMsg = null;
let pendingContentEl = null;
let pendingStarted = false;
let pendingParts = [];
let budgetStopped = false;
let flowEl = null;
let pendingNarration = '';
let lastNarration = '';
let typingEl = null;
let activeRunId = null;
let currentCitations = null; // 当前回答的引用来源元数据
let pageContextEnabled = true;
let citeHighlightEntered = false;
// 每个页面各自独立的对话（conversation 仅存于本页内存），不做跨 tab 同步。

function ensureHost() {
  if (host) return;
  host = document.createElement('div');
  host.id = '__kb-ai-host';
  host.style.all = 'initial';
  host.style.position = 'fixed';
  host.style.zIndex = '2147483647';
  host.style.left = '0';
  host.style.top = '0';
  shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CSS;
  shadow.appendChild(style);

  fab = document.createElement('button');
  fab.className = 'fab';
  const fabIcon = document.createElement('img');
  fabIcon.src = chrome.runtime.getURL('docs/assets/recallflow-mark.svg');
  fabIcon.alt = '';
  fab.appendChild(fabIcon);
  fab.title = 'RecallFlow';
  fab.setAttribute('aria-label', '打开 RecallFlow');
  fab.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    togglePanel();
  });
  fab.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  shadow.appendChild(fab);

  document.documentElement.appendChild(host);
}

function removeBubble() {
  if (bubble) {
    bubble.remove();
    bubble = null;
  }
}

function removePanel() {
  // 流式中关闭面板只是「隐藏」：不关 port、不 endStream，让助手继续生成，
  // 重新打开时能恢复正在输出的内容（见 restoreStreamingUI）。
  if (!streaming) closePort();
  clearCiteHighlight();
  if (panel) {
    if (panel.offsetWidth && panel.offsetHeight) localStorage.setItem('recallflow-panel-size', JSON.stringify({ width: panel.offsetWidth, height: panel.offsetHeight }));
    if (panel._manualPos || panel.style.top !== 'auto') { const r = panel.getBoundingClientRect(); localStorage.setItem('recallflow-panel-pos', JSON.stringify({ left: r.left, top: r.top })); }
    panel.remove();
    panel = null;
    panelBody = null;
    panelTextEl = null;
    if (fab) fab.classList.remove('hidden');
  }
}

function closePort() {
  if (port) {
    try {
      port.disconnect();
    } catch (e) {}
    port = null;
  }
}

function showBubble(x, y) {
  removeBubble();
  removePanel();
  bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = '<span class="dot"></span><span>RecallFlow</span>';
  bubble.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  bubble.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openPanel(x, y);
  });
  shadow.appendChild(bubble);
  const r = bubble.getBoundingClientRect();
  const left = Math.min(Math.max(4, x), window.innerWidth - r.width - 4);
  const top = y - r.height - 8 > 4 ? y - r.height - 8 : y + 12;
  bubble.style.left = left + 'px';
  bubble.style.top = top + 'px';
}

function togglePanel() {
  if (panel) {
    removePanel();
  } else {
    ensureHost();
    lastText = '';
    pageText = pageContextEnabled ? extractPageText() : '';
    openPanel(0, 0, true);
  }
}

// 根据内容自动调整面板高度
function fitPanelHeight() {
  if (!panel || !panelBody) return;
  // 用户调整过窗口尺寸后，严格尊重用户配置，不再覆盖高度。
  if (panel._manualSize) return;
  // 使用视口比例避免 4K 屏幕上面板贴得过低；桌面端限制上下限保证稳定。
  const dockGap = getDockGap();
  const topLimit = Math.max(12, Math.round(window.innerHeight * 0.10));
  // 停靠模式以底部为锚点，最大高度不超过顶部安全区；增长时只向上扩展。
  const maxH = Math.max(320, window.innerHeight - dockGap - topLimit);
  panel.style.height = 'auto';
  panelBody.style.height = 'auto';
  panelBody.style.flex = '';
  panelBody.style.overflowY = 'auto';
  let chromeH = 0;
  for (const child of panel.children) {
    if (child !== panelBody && !child.classList.contains('resize-handle')) chromeH += child.offsetHeight;
  }
  const bodyNatH = panelBody.scrollHeight;
  // 快捷语句、输入区与底栏属于固定区域，优先为它们预留高度；
  // 仅压缩可滚动的对话内容，避免底部“清空对话”被裁掉。
  const bodyAvailableH = Math.max(120, maxH - chromeH);
  const bodyH = Math.min(bodyNatH, bodyAvailableH);
  panelBody.style.flex = 'none';
  panelBody.style.height = bodyH + 'px';
  panelBody.style.overflowY = bodyNatH > bodyH ? 'auto' : 'hidden';
  const totalH = Math.min(maxH, Math.max(320, chromeH + bodyH));
  panel.style.height = totalH + 'px';
  if (panel.classList.contains('docked') && !panel._manualPos) {
    panel.style.top = 'auto';
    panel.style.bottom = dockGap + 'px';
  }
}

// 停靠模式使用相对视口高度的底部留白：大屏幕适当上移，小屏幕保持紧凑。
function getDockGap() {
  return window.innerWidth <= 640 ? 12 : Math.min(520, Math.max(120, Math.round(window.innerHeight * 0.30)));
}

// ---- 轻量语法高亮 ----
const HL_KEYWORDS = new Set(
  'function return if else for while do switch case break continue default new class extends super this const let var typeof instanceof in of try catch finally throw async await yield import export from as static get set null undefined true false void delete package private protected public interface type enum namespace module def elif lambda pass None True False and or not global raise with assert import print del class return if elif else'.split(' ')
);
const HL_TYPES = new Set('String Number Boolean Array Object Function Promise Error Date RegExp Map Set Symbol BigInt Math JSON Console Node Buffer parseInt parseFloat isNaN isFinite JSON.stringify JSON.parse'.split(' '));

function hlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 简单分块高亮：注释 / 字符串 / 关键字 / 数字 / 函数名 / 类型
function highlightCode(code) {
  const esc = hlEscape(code);
  const tokens = [];

  // 组合正则，一次遍历
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(\d+\.\d+|\d+\.?)\b|([A-Za-z_$][\w$]*)/g;
  let last = 0;
  let m;
  while ((m = re.exec(esc))) {
    if (m.index > last) tokens.push(esc.slice(last, m.index));
    if (m[1]) tokens.push('<span class="tk-comment">' + m[1] + '</span>');
    else if (m[2]) tokens.push('<span class="tk-string">' + m[2] + '</span>');
    else if (m[3]) tokens.push('<span class="tk-number">' + m[3] + '</span>');
    else if (m[4]) {
      const w = m[4];
      if (HL_KEYWORDS.has(w)) tokens.push('<span class="tk-keyword">' + w + '</span>');
      else if (HL_TYPES.has(w)) tokens.push('<span class="tk-type">' + w + '</span>');
      else {
        // 函数名：后面紧跟 (
        const after = esc.slice(m.index + w.length, m.index + w.length + 1);
        if (after === '(') tokens.push('<span class="tk-fn">' + w + '</span>');
        else tokens.push(w);
      }
    }
    last = m.index + m[0].length;
  }
  if (last < esc.length) tokens.push(esc.slice(last));
  return tokens.join('');
}

// AI 回复底部操作栏（元宝风格：复制等）
function msgActionsHtml() {
  return '<div class="msg-actions"><button class="act-copy" title="复制回答内容">⧉ 复制</button></div>';
}

function userActionsHtml(index) {
  return '<div class="user-actions"><button class="act-rewind" data-turn-index="' + index + '" title="撤销这条指令及其后续对话">↶ 撤销</button><button class="act-user-copy" title="复制这条指令">⧉ 复制</button></div>';
}

// ---- Markdown 渲染 ----
// citations：可选，传入引用元数据数组后，[n] 会渲染为可点击的引用徽章
// streaming：是否处于流式输出中（为 true 时末尾追加闪烁光标）
function renderMarkdown(md, citations, streaming) {
  const lines = md.split('\n');
  let html = '';
  let inCode = false;
  let codeBuf = [];
  let codeLang = '';
  let listType = null;
  let tableBuf = null;

  const escInline = (s) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  const escAttr = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

  const inline = (s) => {
    let r = escInline(s);
    r = r.replace(/`([^`]+)`/g, '<code>$1</code>');
    r = r.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    r = r.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
    r = r.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    // 将 [n]（或 [标签n] 如 [K8s文档2]）渲染为可点击的引用徽章（仅当存在引用元数据时）。
    // 容错匹配「括号内以数字结尾」的形式，提取数字对齐全局引用编号。
    if (citations && citations.length) {
      r = r.replace(/[\uFF3B\u005B]([^\]]*?)[\uFF3D\u005D]/g, (match, inner) => {
        const idx = extractCiteNum(inner);
        if (idx === null) return match;
        // 按「位置」对齐参考来源区（body [n] → 来源区第 n 条），与重编号后的顺序完全一致。
        const c = citations[idx - 1];
        if (!c) return match;
        const short = c.title.length > 16 ? c.title.slice(0, 16) + '…' : c.title;
        return (
          '<button class="cite-badge" data-cite-id="' + escAttr(c.id || '') + '" data-cite-source="' + escAttr(c.source || 'kb') + '" data-cite-url="' + escAttr(c.url || '') + '" data-cite-snippet="' + escAttr(c.snippet || '') + '" title="打开证据：' + escAttr(c.title) + '">' +
          '<span class="cite-idx">[' + idx + ']</span>' + escAttr(short) + '</button>'
        );
      });
    }
    return r;
  };

  const flushList = () => {
    if (listType) {
      html += '</' + listType + '>';
      listType = null;
    }
  };

  const isTableSep = (l) => /^\s*\|?[\s:\-|]+\|?\s*$/.test(l) && l.includes('-') && l.includes('|');
  const parseRow = (r) => {
    let t = r.trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|')) t = t.slice(0, -1);
    return t.split('|').map((c) => c.trim());
  };
  const flushTable = () => {
    if (!tableBuf) return;
    const head = parseRow(tableBuf[0]);
    const rows = tableBuf.slice(2);
    html +=
      '<div class="md-table-wrap"><table><thead><tr>' +
      head.map((c) => '<th>' + inline(c) + '</th>').join('') +
      '</tr></thead><tbody>' +
      rows.map((r) => '<tr>' + parseRow(r).map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') +
      '</tbody></table></div>';
    tableBuf = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (line.trim().startsWith('```')) {
      if (inCode) {
        html +=
          '<div class="code-wrap"><div class="code-head"><span class="code-lang">' +
          (codeLang ? escAttr(codeLang) : 'code') +
          '</span><button class="code-copy">复制</button></div><pre><code>' +
          highlightCode(codeBuf.join('\n')) + '</code></pre></div>';
        codeBuf = [];
        inCode = false;
        codeLang = '';
      } else {
        flushList();
        flushTable();
        inCode = true;
        codeLang = line.trim().slice(3).trim();
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    // 表格：当前行含 | 且下一行是分隔行时开始收集
    if (tableBuf) {
      if (line.trim() !== '' && line.includes('|')) {
        tableBuf.push(line);
        continue;
      }
      flushTable();
    } else if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushList();
      tableBuf = [line, lines[i + 1]];
      i++;
      continue;
    }
    // 分割线
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushList();
      flushTable();
      html += '<hr>';
      continue;
    }
    const mH = line.match(/^(#{1,4})\s+(.*)/);
    if (mH) {
      flushList();
      flushTable();
      const lv = mH[1].length;
      html += '<h' + lv + '>' + inline(mH[2]) + '</h' + lv + '>';
      continue;
    }
    const mUl = line.match(/^\s*[-*+]\s+(.*)/);
    if (mUl) {
      flushTable();
      if (listType !== 'ul') {
        flushList();
        html += '<ul>';
        listType = 'ul';
      }
      html += '<li>' + inline(mUl[1]) + '</li>';
      continue;
    }
    const mOl = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (mOl) {
      flushTable();
      if (listType !== 'ol') {
        flushList();
        html += '<ol>';
        listType = 'ol';
      }
      html += '<li>' + inline(mOl[1]) + '</li>';
      continue;
    }
    const mBq = line.match(/^\s*>\s?(.*)/);
    if (mBq) {
      flushList();
      flushTable();
      // 合并连续的引用行
      const buf = [mBq[1]];
      while (i + 1 < lines.length) {
        const m2 = lines[i + 1].replace(/\r$/, '').match(/^\s*>\s?(.*)/);
        if (!m2) break;
        buf.push(m2[1]);
        i++;
      }
      html += '<blockquote>' + buf.map(inline).join('<br>') + '</blockquote>';
      continue;
    }
    flushList();
    flushTable();
    if (line.trim() === '') {
      continue;
    }
    html += '<p>' + inline(line) + '</p>';
  }
  flushList();
  flushTable();
  if (streaming) {
    if (html.endsWith('</p>')) {
      html = html.slice(0, -4) + '<span class="stream-cursor"></span></p>';
    } else {
      html += '<p><span class="stream-cursor"></span></p>';
    }
  }
  return html || '<p>（无内容）</p>';
}

// ---- 面板：自由指令 + 流式输出 ----

// ---- 面板布局（大小/位置）本地持久化：写入 localStorage（随页面走，不做跨 tab 同步）----
let layoutTimer = null;

// 节流持久化面板布局（避免拖拽/拉伸 mousemove 高频写入）。
function persistPanelLayoutThrottled() {
  if (layoutTimer || !panel) return;
  layoutTimer = setTimeout(() => { layoutTimer = null; persistPanelLayoutNow(); }, 200);
}

// 立即把当前面板布局写入 localStorage。
function persistPanelLayoutNow() {
  if (!panel) return;
  const r = panel.getBoundingClientRect();
  const layout = { width: panel.offsetWidth, height: panel.offsetHeight, left: Math.round(r.left), top: Math.round(r.top) };
  try {
    localStorage.setItem('recallflow-panel-size', JSON.stringify({ width: layout.width, height: layout.height }));
    localStorage.setItem('recallflow-panel-pos', JSON.stringify({ left: layout.left, top: layout.top }));
  } catch (e) {}
}

// 若会话最后一条是含 <options> 的触底决策建议，渲染可点击方案按钮（防重复渲染）。
function renderDecisionButtonsIfPresent() {
  if (!panelBody || !panel) return;
  if (panelBody.querySelector('.suggestion-options')) return;
  const last = conversation[conversation.length - 1];
  if (last && last.role === 'assistant' && /<options>/i.test(String(last.content || ''))) {
    renderSuggestionButtons(panelBody, last.content, panel._sendFn || activeSendFn);
    fitPanelHeight();
  }
}

// 引用标记匹配：支持 [n]、[ n ]、[标签n]、全角［n］。捕获括号内完整内容，数字取「结尾的数字」。
const CITE_RE = /[\uFF3B\u005B]([^\]]*?)[\uFF3D\u005D]/g;
// 提取括号内容结尾的引用编号；不是引用（无结尾数字）返回 null。
function extractCiteNum(inner) {
  const m = String(inner || '').match(/(\d{1,2})\s*$/);
  return m ? parseInt(m[1], 10) : null;
}

// 最终回复后把引用重编号：按「正文中首次出现的顺序」重排为 1..N，且只保留正文实际引用到的来源。
// 这解决模型对来源编号不可靠的问题——正文永远从 [1] 开始，参考来源只列被引用的文章，二者一一对应。
function renumberCitations(text, citations) {
  const list = Array.isArray(citations) ? citations : [];
  const src = String(text || '');
  // 每次操作都新建正则，杜绝共享 /g 正则的 lastIndex 状态残留
  // （exec 收集与 replace 替换分开用独立正则，绝不串状态）。
  const collectRe = /[\uFF3B\u005B]([^\]]*?)[\uFF3D\u005D]/g;
  // 收集正文里出现的所有不同引用编号（按首次出现顺序）。
  const order = [];
  const seen = new Set();
  let m;
  while ((m = collectRe.exec(src))) {
    const n = extractCiteNum(m[1]);
    if (n === null || seen.has(n)) continue;
    seen.add(n);
    order.push(n);
  }
  if (!order.length) return { text, citations: list };
  // 无条件重编号为连续 1..N，保证正文一定从 [1] 开始。
  const oldToNew = {};
  order.forEach((old, i) => { oldToNew[old] = i + 1; });
  const replaceRe = /[\uFF3B\u005B]([^\]]*?)[\uFF3D\u005D]/g;
  const newText = src.replace(replaceRe, (mm, inner) => {
    const old = extractCiteNum(inner);
    if (old === null) return mm;
    const label = inner.replace(/\s*\d+\s*$/, '');
    return oldToNew[old] !== undefined ? '[' + label + oldToNew[old] + ']' : mm;
  });
  // 参考来源区按「正文引用顺序」构建同样的 N 条：优先取编号匹配的来源；
  // 匹配不到时按注册顺序位置近似补齐，保证来源数量与正文一一对应且从 [1] 连续。
  // 注意：返回全新的对象副本，绝不改动传入的 citations（流式每 chunk 都会重编号，改动会破坏幂等）。
  const cited = order.map((old, k) => {
    const src = list.find((c) => Number(c.index) === old) || list[k] || { title: '来源 ' + (k + 1), url: '', snippet: '' };
    return Object.assign({}, src, { index: k + 1 });
  });
  return { text: newText, citations: cited };
}

// 统一渲染入口：任何回答正文都先重编号引用再渲染，保证界面上永远显示从 [1] 连续的编号，
// 与参考来源区一致。所有 renderMarkdown 调用点都应改用本函数。
function renderAnswer(text, citations, streaming) {
  const ren = renumberCitations(text, citations);
  return renderMarkdown(stripOptionsBlock(ren.text), ren.citations, streaming);
}

// 生成 Chrome 文本片段深链：在 URL 后追加 #:~:text=…，浏览器打开后会自动
// 滚动并高亮证据文本，让「跳转」真正落在引用出处，而不是落到页面顶部。
function buildCitationDeepLink(url, snippet) {
  try {
    const clean = String(snippet || '')
      .replace(/\s+/g, ' ')
      .replace(/…\s*$/, '')
      .replace(/（页面内容过长，已截断）\s*$/, '')
      .trim();
    if (!clean || clean.length < 15) return url;
    const start = clean.slice(0, 60).trim();
    const suffix = clean.slice(60, 88).trim();
    const enc = (s) => encodeURIComponent(s).replace(/-/g, '%2D');
    let frag = ':~:text=' + enc(start);
    if (suffix.length) frag += '-' + enc(suffix);
    return url + (url.indexOf('#') >= 0 ? '' : '#') + frag;
  } catch (e) {
    return url;
  }
}

// 流式中面板被关闭后重新打开：恢复「正在生成的回复」UI。
// 流式状态（pendingNarration/pendingAcc/pendingParts/flowEl 等）都在模块级变量里，
// 不因面板 DOM 重建而丢失，重新挂接元素即可让后续 chunk/end 继续写进新面板。
function restoreStreamingUI() {
  if (!panelBody || !streaming) return;
  if (pendingContentEl && pendingContentEl.isConnected) return; // 已恢复过
  const aiMsg = document.createElement('div');
  aiMsg.className = 'msg ai';
  const flow = document.createElement('div');
  flow.className = 'agent-flow';
  aiMsg.appendChild(flow);
  // 已固化的叙述段与工具步骤先渲染回 flow。
  for (const p of pendingParts) {
    if (p.type === 'narration' && p.text) {
      const d = document.createElement('div');
      d.className = 'agent-content';
      d.innerHTML = renderAnswer(p.text, currentCitations, false);
      flow.appendChild(d);
    } else if (p.type === 'tool-call') {
      const s = document.createElement('div');
      s.className = 'agent-step';
      s.innerHTML = '<span class="agent-tool">🔧 ' + escHtml(p.name) + '</span>';
      flow.appendChild(s);
    } else if (p.type === 'tool-result') {
      const s = document.createElement('div');
      s.className = 'agent-step';
      s.textContent = (p.status === 'completed' ? '✓ 工具已完成：' : p.status === 'failed' ? '✗ 工具失败：' : '— 工具未执行：') + p.name;
      flow.appendChild(s);
    }
  }
  const contentEl = document.createElement('div');
  contentEl.className = 'agent-content';
  if (pendingNarration) {
    contentEl.innerHTML = renderAnswer(pendingNarration, currentCitations, true);
  } else {
    contentEl.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
  }
  flow.appendChild(contentEl);
  panelBody.appendChild(aiMsg);
  pendingAiMsg = aiMsg;
  pendingContentEl = contentEl;
  flowEl = flow;
  typingEl = pendingNarration ? null : contentEl;
  pendingStarted = pendingStarted || Boolean(pendingNarration || pendingAcc);
  pendingAiMsg._raw = pendingAcc;
  fitPanelHeight();
  if (observerAutoScroll && panelBody) panelBody.scrollTop = panelBody.scrollHeight;
}

// 面板内短暂提示（如引用定位失败）。
function showCitationHint(text) {
  if (!panelBody) return;
  const hint = document.createElement('div');
  hint.style.cssText = 'color:#b45309;font-size:11px;margin:4px 0;padding:4px 6px;background:rgba(180,83,9,.08);border-radius:4px;';
  hint.textContent = text;
  panelBody.appendChild(hint);
  fitPanelHeight();
  setTimeout(() => { if (hint.parentNode) hint.parentNode.removeChild(hint); }, 5000);
}

// 当前面板的发送函数（openPanel 里绑定 run），供 renderSuggestionButtons 触发「继续」。
let activeSendFn = null;

// 解析触底建议中的「可选操作」，返回 [{label, desc}]（最多 4 条）。
// 优先解析 <options>JSON</options> 程序块；失败再回退解析 【可选操作】 小节的文本格式。
// 两种情况都解析不到则返回空数组，前端自然退化为纯文本，不报错。
function parseSuggestionOptions(text) {
  const out = [];
  const blockMatch = String(text || '').match(/<options>([\s\S]*?)<\/options>/i);
  if (blockMatch) {
    try {
      const arr = JSON.parse(blockMatch[1].trim());
      if (Array.isArray(arr)) {
        arr.slice(0, 4).forEach((it) => {
          const label = String(it && it.label || '').trim();
          const desc = String(it && it.desc || '').trim();
          if (label) out.push({ label, desc });
        });
        if (out.length) return out;
      }
    } catch (e) {}
  }
  const match = String(text || '').match(/【可选操作】([\s\S]*)$/);
  const section = match ? match[1] : '';
  const re = /(?:^|\n)\s*(?:[-*]|\d+[.、])\s*【([^】\n]{1,12})】\s*([^\n]*)/g;
  let m;
  while ((m = re.exec(section)) && out.length < 4) {
    const label = m[1].trim();
    const desc = m[2].trim();
    if (label) out.push({ label, desc });
  }
  return out;
}

// 从展示文本中隐藏 <options> 程序块（含未闭合时），避免用户看到原始 JSON。
function stripOptionsBlock(text) {
  return String(text || '')
    .replace(/<options>[\s\S]*?(?:<\/options>|$)/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 把建议按钮渲染到 AI 回复下方；点击后以「继续上一任务」方式重发指令。
// sendFn 用于绑定「所属面板」的发送函数。
function renderSuggestionButtons(container, text, sendFn) {
  const options = parseSuggestionOptions(text);
  if (!options.length) return;
  const wrap = document.createElement('div');
  wrap.className = 'suggestion-options';
  const title = document.createElement('div');
  title.className = 'suggestion-title';
  title.textContent = '可选择继续方式：';
  wrap.appendChild(title);
  options.forEach((opt) => {
    const b = document.createElement('button');
    b.className = 'suggestion-option';
    b.textContent = opt.label;
    if (opt.desc) b.title = opt.desc;
    b.addEventListener('click', () => {
      if (streaming) return;
      const fn = sendFn || activeSendFn;
      if (typeof fn === 'function') {
        fn(opt.label + (opt.desc ? '：' + opt.desc : ''), { continuation: true });
      }
    });
    wrap.appendChild(b);
  });
  container.appendChild(wrap);
}

function renderConversation() {
  if (!panelBody) return;
  if (!conversation.length) {
    panelBody.className = 'p-body';
    panelBody.innerHTML = '<div class="msg ai">' + (lastText ? '输入指令，AI 将基于选中文本执行。' : '输入指令，AI 将直接执行（可基于知识库）。') + '</div>';
    return;
  }
  // 渲染引用来源区域
  const citeSourcesHtml = (cites) => {
    if (!cites || !cites.length) return '';
    return (
      '<div class="cite-sources"><span class="cite-label">参考来源：</span>' +
      cites
        .map(
          (c) =>
            '<button class="cite-badge" data-cite-id="' + escAttr(c.id || '') + '" data-cite-source="' + escAttr(c.source || 'kb') + '" data-cite-url="' + escAttr(c.url || '') + '" data-cite-snippet="' + escAttr(c.snippet || '') + '" title="打开证据：' + escAttr(c.title) + '">' +
            '<span class="cite-idx">[' + c.index + ']</span>' + escAttr(c.title.length > 18 ? c.title.slice(0, 18) + '…' : c.title) + '</button>'
        )
        .join('') +
      '</div>'
    );
  };
  const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

  panelBody.className = 'p-body';
  panelBody.innerHTML = conversation
    .map((m, index) => {
      if (m.role === 'user') {
        return '<div class="user-turn"><div class="msg user">' + escHtml(m.content) + '</div>' + userActionsHtml(index) + '</div>';
      }
      const parts = Array.isArray(m.parts) ? m.parts : [];
      const flowHtml = parts
        .map((p) => {
          if (p.type === 'tool-call') {
            return '<div class="agent-step"><span class="agent-tool">🔧 ' + escHtml(p.name) + '</span></div>';
          }
          if (p.type === 'tool-result') {
            return '<div class="agent-step">' + (p.status === 'completed' ? '✓ 工具已完成：' : p.status === 'failed' ? '✗ 工具失败：' : '— 工具未执行：') + escHtml(p.name) + '</div>';
          }
          if (p.type === 'narration' && p.text) {
            return '<div class="agent-content">' + renderAnswer(p.text, m.citations, false) + '</div>';
          }
          if (p.type === 'text' && p.text) {
            return '<div class="agent-content">' + renderAnswer(p.text, m.citations, false) + '</div>';
          }
          return '';
        })
        .join('');
      const hasInlineText = parts.some((p) => p.type === 'narration' || (p.type === 'text' && p.text));
      const contentHtml = hasInlineText ? '' : renderAnswer(m.content || '', m.citations);
      return (
        '<div class="msg ai"><div class="agent-flow">' + flowHtml + '</div>' +
        contentHtml +
        citeSourcesHtml(m.citations) +
        (m.content ? msgActionsHtml() : '') +
        '</div>'
      );
    })
    .join('');
  // 关联原始文本，供操作栏复制使用
  const aiEls = panelBody.querySelectorAll('.msg.ai');
  let aiIdx = 0;
  for (const m of conversation) {
    if (m.role === 'user') continue;
    if (aiEls[aiIdx]) aiEls[aiIdx]._raw = m.content || '';
    aiIdx++;
  }
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function openPanel(x, y, docked) {
  removeBubble();
  removePanel();
  if (fab) fab.classList.add('hidden');

  panel = document.createElement('div');
  panel.className = 'panel';
  if (docked) panel.classList.add('docked');
  try { const saved = JSON.parse(localStorage.getItem('recallflow-panel-size') || 'null'); if (saved) { panel.style.width = Math.min(window.innerWidth - 24, Math.max(280, saved.width)) + 'px'; panel.style.height = Math.min(window.innerHeight - 24, Math.max(320, saved.height)) + 'px'; panel._manualSize = true; } } catch (_) { /* ignore invalid saved size */ }
  let savedPos = null;
  try { savedPos = JSON.parse(localStorage.getItem('recallflow-panel-pos') || 'null'); } catch (_) { savedPos = null; }

  const head = document.createElement('div');
  head.className = 'p-head';
  const logo = document.createElement('img');
  logo.className = 'logo';
  logo.src = chrome.runtime.getURL('docs/assets/recallflow-mark.svg');
  logo.alt = 'RecallFlow';
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = 'RecallFlow';
  const close = document.createElement('button');
  close.className = 'close';
  close.textContent = '✕';
  close.addEventListener('click', removePanel);
  head.appendChild(logo);
  head.appendChild(title);
  head.appendChild(close);
  panel.appendChild(head);

  if (lastText) {
    const text = document.createElement('div');
    text.className = 'p-text';
    text.textContent = lastText.length > 200 ? lastText.slice(0, 200) + '…' : lastText;
    text.title = lastText;
    panelTextEl = text;
    panel.appendChild(text);
  }

  panelBody = document.createElement('div');
  panelBody.className = 'p-body';
  observerAutoScroll = true;
  const pbEl = panelBody;
  pbEl.addEventListener('scroll', () => {
    // 直接引用创建时的元素（不依赖可能被置空的模块变量 panelBody），彻底规避空指针。
    if (!pbEl) return;
    // 距底部 < 40px 视为在底部（恢复自动跟随），否则用户在看历史（暂停跟随）。
    observerAutoScroll = pbEl.scrollHeight - pbEl.scrollTop - pbEl.clientHeight < 40;
  });
  panelBody.addEventListener('click', (e) => {
    const rewind = e.target.closest('.act-rewind');
      if (rewind) {
        if (streaming) return;
        const index = Number(rewind.getAttribute('data-turn-index'));
        if (Number.isInteger(index) && conversation[index] && conversation[index].role === 'user') {
          const undone = conversation[index];
          conversation = conversation.slice(0, index);
          renderConversation();
          fitPanelHeight();
          if (observerAutoScroll && panelBody) panelBody.scrollTop = panelBody.scrollHeight;
          // 撤销后将用户指令回填到输入框，方便修改后重发。
          if (undone && typeof undone.content === 'string') {
            cmdInput.value = undone.content;
            cmdInput.style.height = 'auto';
            cmdInput.style.height = Math.min(120, cmdInput.scrollHeight) + 'px';
            cmdInput.focus();
          }
        }
        return;
      }
    const userCopy = e.target.closest('.act-user-copy');
    if (userCopy) {
      const turn = userCopy.closest('.user-turn');
      const msgEl = turn && turn.querySelector('.msg.user');
      if (msgEl) navigator.clipboard.writeText(msgEl.textContent || '').then(() => {
        userCopy.textContent = '✓ 已复制';
        setTimeout(() => (userCopy.textContent = '⧉ 复制'), 1200);
      });
      return;
    }
    const actBtn = e.target.closest('.act-copy');
    if (actBtn) {
      const msgEl = actBtn.closest('.msg');
      const raw = msgEl && msgEl._raw;
      if (raw) {
        navigator.clipboard.writeText(raw).then(() => {
          actBtn.textContent = '✓ 已复制';
          setTimeout(() => (actBtn.textContent = '⧉ 复制'), 1200);
        });
      }
      return;
    }
    const btn = e.target.closest('.code-copy');
    if (btn) {
      const wrap = btn.closest('.code-wrap');
      const codeEl = wrap && wrap.querySelector('code');
      if (!codeEl) return;
      navigator.clipboard.writeText(codeEl.textContent || '').then(() => {
        btn.textContent = '已复制';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = '复制';
          btn.classList.remove('copied');
        }, 1200);
      });
      return;
    }
    // 引用徽章点击：跳转到对应位置并高亮
    const cite = e.target.closest('.cite-badge');
    if (cite) {
      const id = cite.getAttribute('data-cite-id');
      const source = cite.getAttribute('data-cite-source');
      const url = cite.getAttribute('data-cite-url');
      if (source === 'page') {
        const snippet = cite.getAttribute('data-cite-snippet') || '';
        // 校验引用是否来自当前页面（同源同路径）；当前页可定位则高亮。
        const citeUrl = cite.getAttribute('data-cite-url') || '';
        let samePage = false;
        if (citeUrl) {
          try {
            const u = new URL(citeUrl);
            const cur = new URL(location.href);
            samePage = u.origin === cur.origin && u.pathname === cur.pathname;
          } catch (e) { samePage = false; }
        }
        if (samePage) {
          const found = findAndHighlightCitation(snippet);
          if (!found) {
            // 当前页高亮失败（内容变化/已跳转）→ 回退为深链打开来源页。
            if (citeUrl) window.open(buildCitationDeepLink(citeUrl, snippet), '_blank', 'noopener');
            else showCitationHint('未能在当前页面定位该引用（内容可能已变化或尚未加载）。');
          }
        } else if (citeUrl) {
          // 引用来自其他页面（Agent 读取过的来源页）→ 深链打开并自动滚动到证据文本，不打断当前对话。
          window.open(buildCitationDeepLink(citeUrl, snippet), '_blank', 'noopener');
        } else {
          showCitationHint('该引用没有可打开的链接。');
        }
      } else if (url) {
        window.open(buildCitationDeepLink(url, cite.getAttribute('data-cite-snippet') || ''), '_blank', 'noopener');
      } else if (id) {
        try { chrome.runtime.sendMessage({ type: 'openManager', focusId: id }); } catch (e) {}
      }
    }
  });
  const approvalSettings = document.createElement('div');
  approvalSettings.className = 'approval-settings';
  approvalSettings.innerHTML = '<button class="approval-settings-toggle" type="button">自动批准：读取 <span>›</span></button><div class="approval-settings-popover" hidden><div class="approval-settings-caption">允许这些操作无需逐次确认</div><label><input data-policy="read" type="checkbox"> 读取内容</label><label><input data-policy="edit" type="checkbox"> 编辑知识库</label><label><input data-policy="commands" type="checkbox"> 页面命令</label><label><input data-policy="browser" type="checkbox"> 浏览器与网络</label><label><input data-policy="mcp" type="checkbox"> MCP 服务器</label></div>';
  const approvalToggle = approvalSettings.querySelector('.approval-settings-toggle');
  const approvalPopover = approvalSettings.querySelector('.approval-settings-popover');
  const refreshApprovalLabel = () => {
    const names = { read: '读取', edit: '编辑', commands: '命令', browser: '浏览器', mcp: 'MCP' };
    const on = [...approvalSettings.querySelectorAll('[data-policy]:checked')].map((x) => names[x.dataset.policy]);
  approvalToggle.innerHTML = '自动批准：' + (on.length ? on.join('、') : '无') + ' <span>›</span>';
  };
  approvalToggle.addEventListener('click', () => { approvalPopover.hidden = !approvalPopover.hidden; panel.classList.toggle('approval-open', !approvalPopover.hidden); fitPanelHeight(); });
  getAISettings().then((s) => { const p = s.toolApprovalPolicy || { read: true }; approvalSettings.querySelectorAll('[data-policy]').forEach((x) => { x.checked = p[x.dataset.policy] === true; x.addEventListener('change', async () => { const policy = Object.fromEntries([...approvalSettings.querySelectorAll('[data-policy]')].map((y) => [y.dataset.policy, y.checked])); await chrome.storage.local.set({ aiSettings: { ...s, toolApprovalPolicy: policy } }); refreshApprovalLabel(); }); }); refreshApprovalLabel(); }).catch(() => {});

  renderConversation();
  // 流式中关闭过面板再打开：恢复正在生成的回复 UI（助手在后台继续输出）。
  restoreStreamingUI();
  fitPanelHeight();
  if (observerAutoScroll && panelBody) panelBody.scrollTop = panelBody.scrollHeight;
  renderDecisionButtonsIfPresent();

  const cmdArea = document.createElement('div');
  cmdArea.className = 'cmd-area';
  const approvalArea = document.createElement('div');
  approvalArea.className = 'tool-approval';
  approvalArea.style.display = 'none';
  cmdArea.appendChild(approvalArea);
  const quickWrap = document.createElement('div');
  quickWrap.className = 'quick-prompts';
  cmdArea.appendChild(quickWrap);
  // 自动批准位于快捷指令下方、输入框上方，方便随时调整且不打断输入。
  cmdArea.appendChild(approvalSettings);
  const cmdWrap = document.createElement('div');
  cmdWrap.className = 'cmd-box';
  const cmdInput = document.createElement('textarea');
  cmdInput.className = 'cmd-input';
  cmdInput.rows = 1;
  cmdInput.placeholder = '输入指令后回车，如：翻译成中文 / 解释这段代码 / 优化并补全…';
  const sendBtn = document.createElement('button');
  sendBtn.className = 'cmd-send';
  sendBtn.textContent = '发送';
  cmdWrap.appendChild(cmdInput);
  cmdWrap.appendChild(sendBtn);
  cmdArea.appendChild(cmdWrap);
  panel.appendChild(panelBody);
  panel.appendChild(cmdArea);

  getAISettings().then((s) => {
    quickWrap.innerHTML = '';
    (s.quickPrompts || AI_SETTINGS_DEFAULTS.quickPrompts || []).slice(0, 12).forEach((prompt) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'quick-prompt';
      b.textContent = prompt;
      b.addEventListener('click', () => {
        if (streaming) return;
        run(prompt);
      });
      quickWrap.appendChild(b);
    });
    fitPanelHeight();
  }).catch(() => {});

  const foot = document.createElement('div');
  foot.className = 'p-foot';
  const clearBtn = document.createElement('button');
  clearBtn.textContent = '清空对话';
  clearBtn.addEventListener('click', () => {
    conversation = [];
    renderConversation();
    fitPanelHeight();
  });
  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy-btn';
  copyBtn.textContent = '复制';
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(panelBody.textContent || '').then(() => {
      copyBtn.textContent = '已复制';
      setTimeout(() => (copyBtn.textContent = '复制'), 1200);
    });
  });
  stopBtn = document.createElement('button');
  stopBtn.className = 'stop-btn';
  stopBtn.textContent = '■ 停止';
  stopBtn.style.display = 'none';
  stopBtn.addEventListener('click', interrupt);
  foot.appendChild(clearBtn);
  foot.appendChild(copyBtn);
  foot.appendChild(stopBtn);
  panel.appendChild(foot);

  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'resize-handle bottom-right';
  const startResize = (e, origin) => {
    e.preventDefault();
    e.stopPropagation();
    panel._manualSize = true;
    // 拉伸统一转自由定位：固定当前 left/top，避免 docked 底部锚点（bottom）在拉伸中
    // 与 top 混合导致面板底部“复位/跳动”。之后用 left/top/width/height 精确定位并 clamp。
    panel._manualPos = true;
    const r = panel.getBoundingClientRect();
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left = r.left + 'px';
    panel.style.top = r.top + 'px';
    resizeState = {
      startX: e.clientX,
      startY: e.clientY,
      origWidth: panel.offsetWidth,
      origHeight: panel.offsetHeight,
      origin,
    };
  };
  resizeHandle.addEventListener('mousedown', (e) => startResize(e, 'bottom-right'));
  panel.appendChild(resizeHandle);
  ['top-left','top','top-right','left','right','bottom-left','bottom'].forEach((origin) => { const h = document.createElement('div'); h.className = 'resize-handle ' + origin; h.addEventListener('mousedown', (e) => startResize(e, origin)); panel.appendChild(h); });

  shadow.appendChild(panel);

  const prw = panel.offsetWidth;
  const prh = panel.offsetHeight;
  if (docked) {
    const edgeGap = getDockGap();
    if (savedPos && Number.isFinite(savedPos.left) && Number.isFinite(savedPos.top)) {
      const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);
      panel.style.left = Math.min(maxLeft, Math.max(0, savedPos.left)) + 'px';
      panel.style.top = Math.min(maxTop, Math.max(0, savedPos.top)) + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel._manualPos = true;
    } else {
      panel.style.right = '0px';
      panel.style.left = 'auto';
      panel.style.top = 'auto';
      panel.style.bottom = edgeGap + 'px';
    }
  } else {
    panel.style.right = 'auto';
    const left = Math.min(Math.max(4, x), window.innerWidth - prw - 4);
    const top = Math.min(Math.max(4, y), window.innerHeight - Math.min(prh, window.innerHeight - 24) - 4);
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  }

  function endStream() {
    streaming = false;
    if (stopBtn) stopBtn.style.display = 'none';
    if (sendBtn) sendBtn.disabled = false;
    pendingAiMsg = null;
    pendingContentEl = null;
    pendingStarted = false;
    pendingAcc = '';
    pendingParts = [];
    budgetStopped = false;
    flowEl = null;
    pendingNarration = '';
    lastNarration = '';
    typingEl = null;
  }

  // 移除初始的“正在输入”占位元素，避免它残留在叙述/步骤之前。
  function removeTypingEl() {
    if (typingEl && typingEl.parentNode) {
      typingEl.parentNode.removeChild(typingEl);
      if (pendingContentEl === typingEl) pendingContentEl = null;
    }
    typingEl = null;
  }

  // 当前叙述段落对应的文本元素：每段一个 div，工具步骤插在段落之间。
  function ensureTextEl() {
    if (!flowEl) return null;
    const el = document.createElement('div');
    el.className = 'agent-content';
    flowEl.appendChild(el);
    return el;
  }


  // 追加一个工具步骤卡片：先把已经流式输出的叙述段落固化成一条记录，
  // 再插入步骤，使后续叙述从新元素继续，形成“叙述 → 工具 → 叙述”的时间线。
  function appendStep(step) {
    removeTypingEl();
    if (pendingNarration) {
      lastNarration = pendingNarration;
      pendingParts.push({ type: 'narration', text: pendingNarration });
      // 叙述段结束时用非流式模式重渲染，去掉末尾一直在闪烁的 stream-cursor。
      if (pendingContentEl) {
        pendingContentEl.innerHTML = renderAnswer(pendingNarration, currentCitations, false);
      }
      pendingNarration = '';
    }
    pendingContentEl = null;
    if (flowEl) flowEl.appendChild(step);
  }

  function interrupt() {
    if (!streaming) return;
    const acc = pendingAcc;
    closePort();
      if (pendingAiMsg && pendingAiMsg.parentNode) {
        if (acc) {
          lastResponse = pendingNarration || lastNarration || acc;
          if (pendingContentEl) pendingContentEl.innerHTML = renderAnswer(pendingNarration || lastResponse, currentCitations, false);
          pendingAiMsg._raw = acc;
          pendingParts.push({ type: 'text', text: lastResponse });
          conversation.push({ role: 'assistant', content: acc });
          const note = document.createElement('div');
          note.className = 'stopped-note';
          note.textContent = '· 已停止生成';
          pendingAiMsg.appendChild(note);
          pendingAiMsg.insertAdjacentHTML('beforeend', msgActionsHtml());
        } else {
        if (pendingContentEl) {
          pendingContentEl.textContent = '（已停止）';
          pendingContentEl.style.color = '#999';
        }
      }
    }
    endStream();
    fitPanelHeight();
    if (observerAutoScroll && panelBody) panelBody.scrollTop = panelBody.scrollHeight;
  }

  function run(instruction, opts) {
    closePort();
    activeRunId = 'run-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    // 响应看门狗：避免“三个点一直转”无反馈。15s 提示等待，45s 仍未收到任何消息则报错结束。
    let respTimer = null;
    let respFailTimer = null;
    let respWarned = false;
    const clearRespTimers = () => {
      if (respTimer) { clearTimeout(respTimer); respTimer = null; }
      if (respFailTimer) { clearTimeout(respFailTimer); respFailTimer = null; }
    };
    lastResponse = '';
    conversation.push({ role: 'user', content: instruction });
    const userMsg = document.createElement('div');
    userMsg.className = 'user-turn';
    userMsg.innerHTML = '<div class="msg user">' + escHtml(instruction) + '</div>' + userActionsHtml(conversation.length - 1);
    const aiMsg = document.createElement('div');
    aiMsg.className = 'msg ai';
    flowEl = document.createElement('div');
    flowEl.className = 'agent-flow';
    const contentEl = document.createElement('div');
    contentEl.className = 'agent-content';
    contentEl.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
    flowEl.appendChild(contentEl);
    aiMsg.appendChild(flowEl);
    panelBody.appendChild(userMsg);
    panelBody.appendChild(aiMsg);
    fitPanelHeight();
    if (observerAutoScroll && panelBody) panelBody.scrollTop = panelBody.scrollHeight;

    pendingAcc = '';
    pendingAiMsg = aiMsg;
    pendingContentEl = contentEl;
    typingEl = contentEl;
    pendingStarted = false;
    streaming = true;
    if (stopBtn) stopBtn.style.display = '';
    if (sendBtn) sendBtn.disabled = true;

    if (!isExtContextAlive()) {
      showCitationHint('扩展已更新，当前页面的助手已失效，请刷新页面后重试。');
      endStream();
      return;
    }
    try {
      port = chrome.runtime.connect({ name: 'ai-stream' });
    } catch (e) {
      showCitationHint('扩展已更新，当前页面的助手已失效，请刷新页面后重试。');
      endStream();
      return;
    }
    const conn = port;
    conn.onMessage.addListener((resp) => {
      if (resp.runId && resp.runId !== activeRunId) return;
      clearRespTimers();
      if (resp.type === 'citations') {
        currentCitations = resp.citations || null;
      } else if (resp.type === 'tool-call') {
        pendingParts.push({ type: 'tool-call', callId: resp.callId, name: resp.name, args: resp.args || {}, risk: resp.risk || 'unknown' });
        const step = document.createElement('div');
        step.className = 'agent-step';
        const argStr = resp.args && resp.args.query ? resp.args.query : resp.args && resp.args.id ? resp.args.id : '';
        step.innerHTML =
          '<span class="agent-tool">🔧 ' + escHtml(resp.name) + '</span>' +
          (argStr ? '<span class="agent-tool-arg">：' + escHtml(argStr) + '</span>' : '');
        appendStep(step);
        if (resp.requiresApproval) {
          const approvalArgs = resp.name === 'type_text' && resp.args
            ? { ...resp.args, text: '[输入内容已隐藏]' }
            : resp.name === 'run_javascript' && resp.args
              ? { ...resp.args, code: String(resp.args.code || '').slice(0, 400) + (String(resp.args.code || '').length > 400 ? '…（代码已截断）' : '') }
              : resp.args;
          const detail = approvalArgs && Object.keys(approvalArgs).length ? ' 参数：' + JSON.stringify(approvalArgs) : '';
          const riskLabel = resp.risk === 'high' ? '高风险' : resp.risk === 'medium' ? '需确认' : '外部操作';
          // 高风险工具（run_javascript）不允许“本次会话允许”，避免一次放行长期免审。
          const sessionBtn = resp.name === 'run_javascript'
            ? ''
            : '<button class="tool-approve-session" aria-label="本次会话允许此工具">本次会话允许</button>';
          approvalArea.innerHTML =
            '<div class="tool-approval-title">执行前需要你的确认</div>' +
            '<div class="tool-approval-summary">Agent 请求调用 <span class="tool-approval-tool">' + escHtml(resp.name) + '</span><span class="tool-approval-risk">' + riskLabel + '</span></div>' +
            (detail ? '<div class="tool-approval-detail">' + escHtml(detail.replace(/^ 参数：/, '')) + '</div>' : '') +
            '<div class="tool-approval-actions"><button class="tool-approve" aria-label="仅允许本次工具调用">允许一次</button>' + sessionBtn + '<button class="tool-reject" aria-label="拒绝工具调用">拒绝</button></div>';
          approvalArea.style.display = '';
          const decide = (decision) => {
            conn.postMessage({ type: 'tool-approval', callId: resp.callId, decision });
            approvalArea.style.display = 'none';
            approvalArea.innerHTML = '';
          };
          approvalArea.querySelector('.tool-approve').addEventListener('click', () => decide('once'));
          const sessionEl = approvalArea.querySelector('.tool-approve-session');
          if (sessionEl) sessionEl.addEventListener('click', () => decide('session'));
          approvalArea.querySelector('.tool-reject').addEventListener('click', () => decide('reject'));
        }
        fitPanelHeight();
        if (observerAutoScroll && panelBody) panelBody.scrollTop = panelBody.scrollHeight;
      } else if (resp.type === 'tool-result') {
        pendingParts.push({ type: 'tool-result', callId: resp.callId, name: resp.name, status: resp.status, result: resp.result || '' });
        const step = document.createElement('div');
        step.className = 'agent-step';
        step.textContent = resp.status === 'completed' ? '✓ 工具已完成：' + resp.name : resp.status === 'failed' ? '✗ 工具失败：' + resp.name : '— 工具未执行：' + resp.name;
        appendStep(step);
        fitPanelHeight();
        if (observerAutoScroll && panelBody) panelBody.scrollTop = panelBody.scrollHeight;
      } else if (resp.type === 'stuck-warning') {
        const step = document.createElement('div');
        step.className = 'agent-step';
        step.style.color = '#b45309';
        step.textContent = '⚠ ' + (resp.message || '动作暂未产生可观察进展');
        appendStep(step);
        fitPanelHeight();
        if (observerAutoScroll && panelBody) panelBody.scrollTop = panelBody.scrollHeight;
      } else if (resp.type === 'tool-disabled') {
        const step = document.createElement('div');
        step.className = 'agent-step';
        step.style.color = '#6b7280';
        step.textContent = '⛔ 已停止使用工具「' + (resp.name || '') + '」：' + (resp.reason || '');
        appendStep(step);
        fitPanelHeight();
        if (observerAutoScroll && panelBody) panelBody.scrollTop = panelBody.scrollHeight;
      } else if (resp.type === 'budget-exceeded') {
        budgetStopped = true;
        const step = document.createElement('div');
        step.className = 'agent-step';
        step.style.color = '#b91c1c';
        step.textContent = '⏹ ' + (resp.message || 'Agent 已达到安全上限并停止');
        appendStep(step);
        fitPanelHeight();
        if (observerAutoScroll && panelBody) panelBody.scrollTop = panelBody.scrollHeight;
      } else if (resp.type === 'tab-switched') {
        const step = document.createElement('div');
        step.className = 'agent-step';
        step.textContent = '↗ 已切换标签页：' + (resp.title || resp.url || ('tabId=' + resp.tabId));
        appendStep(step);
        fitPanelHeight();
        if (observerAutoScroll && panelBody) panelBody.scrollTop = panelBody.scrollHeight;
      } else if (resp.type === 'tabs-closed') {
        const count = Array.isArray(resp.tabIds) ? resp.tabIds.length : 0;
        if (count) {
          const step = document.createElement('div');
          step.className = 'agent-step';
          step.style.color = '#6b7280';
          step.textContent = '🗑 任务结束，已自动关闭 ' + count + ' 个本次打开的标签页';
          appendStep(step);
          fitPanelHeight();
          if (observerAutoScroll && panelBody) panelBody.scrollTop = panelBody.scrollHeight;
        }
      } else if (resp.type === 'intent') {
        const step = document.createElement('div');
        step.className = 'agent-step';
        step.textContent = '🧭 意图识别：' + (resp.label || resp.intent || '普通对话');
        appendStep(step);
        fitPanelHeight();
        if (observerAutoScroll && panelBody) panelBody.scrollTop = panelBody.scrollHeight;
      } else if (resp.type === 'intent-upgraded') {
        const step = document.createElement('div');
        step.className = 'agent-step';
        step.textContent = '🔄 已切换为' + (resp.label || '资料研究') + '模式，可用浏览器/网络工具继续';
        appendStep(step);
        fitPanelHeight();
        if (observerAutoScroll && panelBody) panelBody.scrollTop = panelBody.scrollHeight;
      } else if (resp.type === 'skill') {
        const skills = Array.isArray(resp.skills) ? resp.skills : [];
        if (skills.length) {
          const step = document.createElement('div');
          step.className = 'agent-step agent-skill';
          step.textContent = '🛠 启用技能：' + skills.map((s) => s.title || s.name).join('、');
          appendStep(step);
          fitPanelHeight();
          if (observerAutoScroll && panelBody) panelBody.scrollTop = panelBody.scrollHeight;
        }
      } else if (resp.type === 'chunk') {
        removeTypingEl();
        pendingAcc += resp.text;
        pendingNarration += resp.text;
        pendingStarted = true;
        if (!pendingContentEl) {
          pendingContentEl = ensureTextEl();
          if (pendingContentEl) pendingContentEl.innerHTML = '';
        }
        // 流式过程中也统一重编号引用，保证正文始终从 [1] 连续（生成结束后会再次校正，幂等）。
        if (pendingContentEl) {
          pendingContentEl.innerHTML = renderAnswer(pendingNarration, currentCitations, true);
        }
        pendingAiMsg._raw = pendingAcc;
        fitPanelHeight();
        if (observerAutoScroll && panelBody) panelBody.scrollTop = panelBody.scrollHeight;
      } else if (resp.type === 'end') {
        removeTypingEl();
        lastResponse = pendingNarration || lastNarration || '';
        // 最终回复统一重编号引用：正文从 [1] 开始，参考来源只保留被引用的文章。
        const renumbered = renumberCitations(lastResponse, currentCitations);
        const finalText = renumbered.text;
        const finalCitations = renumbered.citations;
        if (typeof console !== 'undefined') {
          const raw = String(lastResponse);
          console.log('[cite] ========== 开始 ==========');
          console.log('[cite] ===== 原文全文 =====');
          console.log(raw);
          console.log('[cite] ===== 原文引用标记 =====');
          console.log('[cite]', JSON.stringify((raw.match(CITE_RE) || [])));
          console.log('[cite] ===== 重编号后全文 =====');
          console.log(finalText);
          console.log('[cite] ===== 展示的参考来源(finalCitations) =====');
          console.log('[cite]', JSON.stringify((finalCitations || []).map((c) => c.index + ':' + c.url)));
          console.log('[cite] ===== 原始注册来源(currentCitations) =====');
          console.log('[cite]', JSON.stringify((currentCitations || []).map((c) => c.index + ':' + c.url)));
          console.log('[cite] ========== 结束 ==========');
        }
        if (!pendingStarted) {
          const el = ensureTextEl();
          if (el) el.textContent = budgetStopped ? '（任务已停止，未生成最终回复）' : '（无返回内容）';
        } else if (pendingContentEl) {
          pendingContentEl.innerHTML = renderAnswer(lastResponse, currentCitations, false);
          pendingAiMsg._raw = pendingAcc;
        }
        // 只把“最后一段”记为最终文本，避免与已固化的叙述段重复。
        pendingParts.push({ type: 'text', text: pendingNarration ? finalText : '' });
        // 附加引用来源区域（仅列出正文实际引用的来源）
        if (finalCitations.length) {
          const srcWrap = document.createElement('div');
          srcWrap.className = 'cite-sources';
          srcWrap.innerHTML =
            '<span class="cite-label">参考来源：</span>' +
            finalCitations
              .map((c) => {
                const t = c.title.length > 18 ? c.title.slice(0, 18) + '…' : c.title;
                const idAttr = String(c.id).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
                const tAttr = String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
                const titleAttr = String(c.title).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
                const sourceAttr = String(c.source || 'kb').replace(/"/g, '&quot;');
                const urlAttr = String(c.url || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
                const snippetAttr = String(c.snippet || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
                return '<button class="cite-badge" data-cite-id="' + idAttr + '" data-cite-source="' + sourceAttr + '" data-cite-url="' + urlAttr + '" data-cite-snippet="' + snippetAttr + '" title="打开证据：' + titleAttr + '"><span class="cite-idx">[' + c.index + ']</span>' + tAttr + '</button>';
              })
              .join('');
          pendingAiMsg.appendChild(srcWrap);
        }
        if (lastResponse) pendingAiMsg.insertAdjacentHTML('beforeend', msgActionsHtml());
        pendingParts.push({ type: 'text', text: lastResponse });
        conversation.push({ role: 'assistant', content: finalText, citations: finalCitations, parts: pendingParts.map((p) => (p.type === 'text' && p.text === lastResponse ? Object.assign({}, p, { text: finalText }) : p)) });
        // 触底收尾：解析模型输出的「【可选操作】」小节，渲染可点击继续按钮。
        renderSuggestionButtons(pendingAiMsg, finalText, run);
        fitPanelHeight();
        currentCitations = null;
        endStream();
        closePort();
      } else if (resp.type === 'error') {
        removeTypingEl();
        const errEl = pendingContentEl || ensureTextEl();
        if (errEl) {
          errEl.textContent = resp.error;
          errEl.style.color = '#e74c3c';
        }
        if (resp.needSetup) {
          const go = document.createElement('button');
          go.textContent = '打开设置';
          go.style.cssText =
            'margin-left:8px;border:1px solid #4a90d9;color:#4a90d9;background:none;border-radius:6px;padding:3px 10px;cursor:pointer;font-size:12px;';
          go.addEventListener('click', () => { try { chrome.runtime.sendMessage({ type: 'openOptions' }); } catch (e) {} });
          pendingAiMsg.appendChild(document.createElement('br'));
          pendingAiMsg.appendChild(go);
        }
        endStream();
        closePort();
      }
    });
    conn.onDisconnect.addListener(() => {
      if (port === conn) port = null;
      if (port === null && streaming) endStream();
    });
    conn.postMessage({
      action: 'agent',
      runId: activeRunId,
      question: instruction,
      text: lastText,
      page: pageText,
      pageUrl: location.href,
      pageTitle: document.title,
      history: conversation.slice(0, -1),
      ...(opts && opts.continuation ? { continuation: true } : {}),
    });
    // 15 秒无任何回流 → 提示等待；45 秒仍无 → 报错结束，避免无限转圈。
    respTimer = setTimeout(() => {
      if (!streaming || respWarned) return;
      respWarned = true;
      if (pendingContentEl) {
        const note = document.createElement('div');
        note.style.cssText = 'color:#999;font-size:11px;margin-top:4px;';
        note.textContent = '⏳ 正在等待模型响应…（网络较慢或模型繁忙）';
        pendingContentEl.appendChild(note);
      }
    }, 15000);
    respFailTimer = setTimeout(() => {
      if (!streaming) return;
      const el = pendingContentEl || ensureTextEl();
      if (el) { el.textContent = '未收到模型响应，请检查网络连接或 API 配置后重试。'; el.style.color = '#e74c3c'; }
      endStream();
      closePort();
    }, 45000);
  }

  function send() {
    if (streaming) return;
    const cmd = cmdInput.value.trim();
    if (!cmd) return;
    run(cmd);
    cmdInput.value = '';
    cmdInput.style.height = 'auto';
    cmdInput.style.height = '34px';
    cmdInput.focus();
  }

  // 绑定当前面板的发送函数到面板元素，供「决策建议按钮」触发继续。
  panel._sendFn = run;
  activeSendFn = run;

  sendBtn.addEventListener('click', send);
  cmdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      removePanel();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  cmdInput.addEventListener('input', () => {
    cmdInput.style.height = 'auto';
    cmdInput.style.height = Math.min(120, cmdInput.scrollHeight) + 'px';
  });
  cmdInput.focus();

  // 拖拽
  head.addEventListener('mousedown', (e) => {
    if (e.target.closest('.close')) return;
    // 用视口坐标作起点，脱离 dock 底停靠（bottom）后立即固定到当前位置，保证后续平移基准正确。
    dragState = {
      startX: e.clientX,
      startY: e.clientY,
      origLeft: panel.getBoundingClientRect().left,
      origTop: panel.getBoundingClientRect().top,
    };
    panel._manualPos = true;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left = dragState.origLeft + 'px';
    panel.style.top = dragState.origTop + 'px';
    e.preventDefault();
  });
}

// 选中新内容时，刷新已打开的对话框
function refreshPanelForSelection() {
  // 流式中不打断当前生成，仅刷新选中文本预览；正在输出的回复通过 restoreStreamingUI 恢复。
  if (!streaming) closePort();
  lastResponse = '';
  if (panelTextEl) {
    panelTextEl.textContent = lastText.length > 200 ? lastText.slice(0, 200) + '…' : lastText;
    panelTextEl.title = lastText;
  }
  renderConversation();
  restoreStreamingUI();
}

// 面板是否自动跟随底部：用户手动向上滚动（查看历史）时置 false，滚回底部恢复。
let observerAutoScroll = true;

// ---- 事件绑定与初始化 ----
export function initAssistant() {
  document.addEventListener('mousedown', (e) => {
    if (host && e.composedPath().includes(host)) return;
    removeBubble();
  });

  document.addEventListener('scroll', () => removeBubble(), true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      removeBubble();
      if (panel) {
        removePanel();
        return;
      }
    }
  }, true);

  document.addEventListener('mousemove', (e) => {
    // 高亮覆盖层不接管鼠标事件，改为根据 Range 判断指针是否进入/离开证据文本。
    // 只有用户实际进入过高亮内容后才在离开时清除，避免点击引用后立刻消失。
    const inCitation = isPointerInCitationRange(e);
    if (inCitation) citeHighlightEntered = true;
    else if (citeHighlightEntered) {
      citeHighlightEntered = false;
      clearCiteHighlight();
    }
    if (dragState && panel) {
      const dx = e.clientX - dragState.startX;
      const dy = e.clientY - dragState.startY;
      let left = dragState.origLeft + dx;
      let top = dragState.origTop + dy;
      // 边界限制：保证面板完整可见（面板小于视口时），面板高于视口时至少保留头部可抓取，
      // 避免被拖出视口后无法再交互（尤其拖出底部后输入区不可达）。
      const pw = panel.offsetWidth;
      const ph = panel.offsetHeight;
      const maxLeft = Math.max(0, window.innerWidth - Math.min(pw, window.innerWidth - 24));
      const maxTop = Math.max(0, window.innerHeight - Math.min(ph, window.innerHeight - 24));
      left = Math.min(Math.max(0, left), maxLeft);
      top = Math.min(Math.max(0, top), maxTop);
      panel.style.left = left + 'px';
      panel.style.top = top + 'px';
      // 位置变化节流写入 localStorage（随页面持久化）。
      persistPanelLayoutThrottled();
    } else if (resizeState && panel) {
      const dw = e.clientX - resizeState.startX;
      const dh = e.clientY - resizeState.startY;
      const minW = 280, minH = 320;
      const maxW = Math.max(minW, window.innerWidth - 24);
      const maxH = Math.max(minH, window.innerHeight - 24);
      const leftSide = resizeState.origin.includes('left');
      const topSide = resizeState.origin.includes('top');
      const rightSide = resizeState.origin.includes('right');
      const bottomSide = resizeState.origin.includes('bottom');
      let w = Math.max(minW, Math.min(maxW, resizeState.origWidth + (leftSide ? -dw : (rightSide ? dw : 0))));
      let h = Math.max(minH, Math.min(maxH, resizeState.origHeight + (topSide ? -dh : (bottomSide ? dh : 0))));
      // 保持对边锚点：拉伸左/上边时，右/下边缘不动；拉伸右/下边时 left/top 不动。
      const r = panel.getBoundingClientRect();
      let left = r.left;
      let top = r.top;
      if (leftSide) left = r.right - w;
      if (topSide) top = r.bottom - h;
      // clamp 到视口内：面板完整可见（高度已被 maxH 限制，不会超过视口），
      // 避免拉伸导致面板底部/顶部被拖出视口后无法交互（“底部复位”问题）。
      left = Math.min(Math.max(0, left), Math.max(0, window.innerWidth - w));
      top = Math.min(Math.max(0, top), Math.max(0, window.innerHeight - h));
      panel.style.left = left + 'px';
      panel.style.top = top + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.width = w + 'px';
      panel.style.height = h + 'px';
      // 手动拉伸后恢复消息区的 flex 布局，避免新增高度堆积在输入框下方。
      if (panelBody) {
        panelBody.style.flex = '1 1 auto';
        panelBody.style.height = 'auto';
        panelBody.style.overflowY = 'auto';
      }
      // 大小/位置变化节流写入 localStorage（随页面持久化）。
      persistPanelLayoutThrottled();
    }
  });
  document.addEventListener('mouseup', () => {
    // 拖拽/拉伸结束：立即持久化最终布局。
    if (dragState || resizeState) {
      if (layoutTimer) { clearTimeout(layoutTimer); layoutTimer = null; }
      persistPanelLayoutNow();
    }
    dragState = null;
    resizeState = null;
  });

  document.addEventListener('mouseup', (e) => {
    if (host && e.composedPath().includes(host)) return;
    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : '';
    if (text.length < 2) {
      removeBubble();
      return;
    }
    lastText = text;
    clearCiteHighlight();
    pageText = pageContextEnabled ? extractPageText() : '';
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    if (panel) {
      refreshPanelForSelection();
      return;
    }
    ensureHost();
    showBubble(rect.left + rect.width / 2, rect.top + window.scrollY);
  });

  getAISettings().then((s) => {
    pageContextEnabled = s.pageContext !== false;
  }).catch(() => {});

  ensureHost();
}
