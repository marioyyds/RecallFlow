// Pure HTML/text formatters shared by live and restored conversations.
// ---- 轻量语法高亮 ----
// AI 回复底部操作栏（元宝风格：复制等）
function msgActionsHtml(isLast: any) {
  return (
    '<div class="msg-actions"><button class="act-copy" title="复制回答内容">⧉ 复制</button>' +
    (isLast ? '<button class="act-regen" title="按上一条指令重新生成">⟳ 重新生成</button>' : '') +
    '</div>'
  );
}

// ---- 工具步骤渲染：默认一行摘要，点开看完整参数/结果 ----

// 摘要里只显示「最能说明这一步在做什么」的参数，避免摘要行过长。
function argHint(args: any) {
  if (!args || typeof args !== 'object') return '';
  if (typeof args.query === 'string') return args.query;
  if (typeof args.id === 'string') return args.id;
  if (typeof args.selector === 'string') return args.selector;
  if (Array.isArray(args.selectors) && args.selectors.length) {
    const head = args.selectors.slice(0, 3).join('、');
    return args.selectors.length > 3 ? head + ' 等 ' + args.selectors.length + ' 个' : head;
  }
  if (typeof args.text === 'string') return args.text;
  // type_text 的负载是 value；不写这一条时，步骤行会退化成「ref、clearFirst」这种键名提示。
  if (typeof args.value === 'string') return args.value;
  if (typeof args.urls === 'object' && args.urls) return '';
  if (typeof args.url === 'string') return args.url;
  if (typeof args.code === 'string') return args.code.replace(/\s+/g, ' ').slice(0, 60);
  const keys = Object.keys(args).filter((k) => args[k] !== undefined && args[k] !== '');
  return keys.length ? keys.slice(0, 3).join('、') : '';
}

function userActionsHtml(index: any) {
  return '<div class="user-actions"><button class="act-rewind" data-turn-index="' + index + '" title="撤销这条指令及其后续对话">↶ 撤销</button><button class="act-user-copy" title="复制这条指令">⧉ 复制</button></div>';
}

// 流式中面板被关闭后重新打开：恢复「正在生成的回复」UI。
// 流式状态（pendingNarration/pendingAcc/pendingParts/flowEl 等）都在模块级变量里，
// 不因面板 DOM 重建而丢失，重新挂接元素即可让后续 chunk/end 继续写进新面板。
//
// ⚠ 下面两个思考记录的挂载函数**必须留在模块顶层**：
// 它们被本函数（模块级）调用，而 openPanel 内部的函数在模块级不可见。
// 这个坑真实发生过一次 —— 当时把 mountThinkSegment 写在 openPanel 里，
// 于是「流式中重开面板」这条路一走到就 ReferenceError，而
// ① 接线门禁是源码正则（看不到作用域）② E2E 从没在流式中重开过面板 —— 两边都没抓到。
// 现在有 tests/panel-scope.test.mjs 专门盯「模块级函数不得调用更深层的函数」。

/**
 * 思考块的标题文案（**唯一来源**：实时刷新与标记生成共用，避免两处文案漂移）。
 *
 * 「保存时已截断」不是装饰：持久化会按 `MAX_PART_TEXT_CHARS` 裁掉超长思维链
 *（见 lib/page/transcript.js 的 clipPart），若重开面板后把它当成完整全文显示，
 * 用户会以为模型只想到这儿 —— 本仓库硬纪律：丢东西必须说明。
 */
function thinkLabelText(done: any, len: any, truncated: any) {
  if (!done) return '思考中…';
  return '已思考（' + len + ' 字' + (truncated ? '，保存时已截断' : '') + '）';
}

function sessionTimeText(ts: any) {
  const n = Number(ts) || 0;
  if (!n) return '';
  const d = new Date(n);
  const pad = (v: any) => String(v).padStart(2, '0');
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// 对话持久化（按 tab，存 chrome.storage.session）：SPA 跳转 / 刷新后仍保留上下文。
// 把一轮里的工具执行轨迹压成一行摘要，随 assistant 消息一起保存，
// 使「继续上一步」时模型能看到做过什么（见 context.js normalizeHistory）。
function summarizeToolParts(parts: any) {
  const done = (Array.isArray(parts) ? parts : []).filter((p) => p && p.type === 'tool-result');
  if (!done.length) return '';
  return done
    .slice(-6)
    .map((p) => p.name + (p.status === 'failed' ? '（失败）' : '') + '：' + String(p.result || '').replace(/\s+/g, ' ').trim().slice(0, 120))
    .join('；');
}

export {
  argHint,
  msgActionsHtml,
  sessionTimeText,
  summarizeToolParts,
  thinkLabelText,
  userActionsHtml,
};
