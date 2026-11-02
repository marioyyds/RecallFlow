// 面板布局不变式（纯 CSS 字符串层面）：
//
// 起因是一个真实故障：「对话窗的滚动条不能点击」。原因是 .resize-handle.right
// 是绝对定位 + z-index:5 的 10px 宽抓取条，贴在面板右边缘；而 .p-body 的滚动条
// 也在面板右边缘（8px 宽）。两者完全重叠 → mousedown 被 resize 抢走，
// 滚动条既点不动也拖不动。
//
// 这类 bug 在代码里完全看不出来（两条 CSS 规则各自都"正确"），
// 只能靠几何关系检查。所以把关系写成可执行的断言：谁改动其中一个数字，
// 这里立刻失败。
import test from 'node:test';
import assert from 'node:assert/strict';

import { PANEL_CSS } from '../lib/ui/page/panel-css.ts';

/** 取出某个选择器的规则体（要求 `{` 紧跟选择器，故 `.panel.dark` 不会误配 `.panel`；
 *  且选择器必须从行首/前一条规则结束后开始 —— 否则 `.panel.embedded .resize-handle`
 *  这类后代规则会被误当成 `.resize-handle` 本体）。 */
function ruleBody(selector) {
  const m = new RegExp('(?:^|[}\\n]\\s*)' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}').exec(PANEL_CSS);
  return m ? m[1] : null;
}

/** 解析长度：支持 `12px` 与 `var(--rf-edge)`（变量从 .panel 规则里取）。 */
function resolveLen(text, varValue) {
  const v = /var\(\s*--rf-edge\s*\)/.exec(text);
  if (v) return varValue;
  const px = /(-?[\d.]+)px/.exec(text);
  return px ? Number(px[1]) : null;
}

const panelRule = ruleBody('.panel');
const rfEdgeMatch = panelRule && /--rf-edge:\s*([\d.]+)px/.exec(panelRule);
const RF_EDGE = rfEdgeMatch ? Number(rfEdgeMatch[1]) : null;

test('前置：--rf-edge 变量存在且为正数', () => {
  assert.ok(panelRule, '找不到 .panel 规则');
  assert.ok(RF_EDGE !== null && RF_EDGE > 0, '找不到 --rf-edge，实际：' + panelRule.slice(0, 200));
});

test('滚动条不会被右侧 resize 手柄盖住（本次故障的回归测试）', () => {
  const body = ruleBody('.p-body');
  const right = ruleBody('.resize-handle.right');
  assert.ok(body, '找不到 .p-body 规则');
  assert.ok(right, '找不到 .resize-handle.right 规则');

  const inset = resolveLen(/margin-right:([^;]*)/.exec(body)?.[1] || '', RF_EDGE);
  const handleW = resolveLen(/width:([^;]*)/.exec(right)?.[1] || '', RF_EDGE);

  assert.ok(typeof inset === 'number', '.p-body 必须设置 margin-right（否则滚动条会贴着手柄）');
  assert.ok(typeof handleW === 'number', '.resize-handle.right 必须有宽度');

  // 手柄占据 [面板宽 - handleW, 面板宽]；.p-body 右缘在 面板宽 - inset。
  // 滚动条贴着 .p-body 的右缘（padding-right 不会把滚动条推进来），
  // 所以互不重叠的充要条件就是 inset >= handleW。
  assert.ok(
    inset >= handleW,
    '滚动条会落进 resize 手柄的抓取区，导致点不动：.p-body margin-right=' +
      inset + 'px < 手柄宽 ' + handleW + 'px'
  );
});

test('两侧内缩与手柄宽度用同一个变量（避免两处数字各改一半）', () => {
  const body = ruleBody('.p-body');
  const right = ruleBody('.resize-handle.right');
  const left = ruleBody('.resize-handle.left');
  assert.match(body, /margin-right:\s*var\(--rf-edge\)/, '.p-body 应使用 var(--rf-edge) 而不是硬编码像素');
  assert.match(right, /width:\s*var\(--rf-edge\)/, '.resize-handle.right 应使用 var(--rf-edge)');
  assert.match(left, /width:\s*var\(--rf-edge\)/, '.resize-handle.left 应使用 var(--rf-edge)');
});

test('手柄确实压在正文之上（这正是必须内缩的原因，别把 z-index 去掉）', () => {
  const base = ruleBody('.resize-handle');
  assert.ok(base, '找不到 .resize-handle 规则');
  const z = /z-index:\s*(\d+)/.exec(base);
  assert.ok(z && Number(z[1]) >= 1, '.resize-handle 未设置 z-index —— 若它已在正文之下，内缩就不必要了，本测试需同步更新');
  assert.match(base, /position:\s*absolute/, '.resize-handle 必须绝对定位');
});

test('滚动条本身有可见样式（宽度/滑块），否则用户根本看不到它', () => {
  assert.ok(ruleBody('.p-body::-webkit-scrollbar'), '缺少 ::-webkit-scrollbar 宽度规则');
  assert.ok(ruleBody('.p-body::-webkit-scrollbar-thumb'), '缺少滑块样式');
});

test('滚动容器仍有可滚动所需的 flex 设置（min-height:0 缺失会导致滚不动）', () => {
  const body = ruleBody('.p-body');
  assert.match(body, /overflow-y:\s*auto/);
  assert.match(body, /min-height:\s*0/, 'flex 子项默认 min-height:auto，会撑破容器导致无法滚动');
});

// ---- 缩放手柄的「可见性」不变式 ----
//
// 起因（用户反馈）：「浮层和嵌入都不好调节窗口框的大小」。
// 代码层面八个手柄都在、cursor 也对，但 `::after`（那个 L 形抓手）一直是
// `opacity: 0` —— 用户看到的只是一条隐形的 10px 带子，等于「看不见=不能拖」。
// 这类回归只能钉在 CSS 字符串上，因为几何全对。

test('手柄抓手默认就可见（不能是 opacity:0 的隐形条）', () => {
  const grip = ruleBody('.resize-handle::after');
  assert.ok(grip, '找不到 .resize-handle::after 规则');
  // 规则体里有说明性注释（提到历史上的 opacity:0），先剥掉注释再取值。
  const decls = grip.replace(/\/\*[\s\S]*?\*\//g, '');
  const opacity = /opacity:\s*([\d.]+)/.exec(decls);
  assert.ok(opacity, '.resize-handle::after 必须显式设置 opacity');
  assert.ok(
    Number(opacity[1]) > 0,
    '.resize-handle::after 的 opacity 是 0 —— 抓手看不见，用户不会想到去拖：' + opacity[1]
  );
  const hover = /\.resize-handle:hover::after[^{]*\{[^}]*opacity:\s*1/.test(PANEL_CSS);
  assert.ok(hover, '.resize-handle:hover::after 应把抓手强化到 opacity:1');
});

test('四条平边（上下左右）有 hover 强调线，弥补角落抓手的空缺', () => {
  // 基础规则（四个平边共用）负责「定位 + 默认不可见」，每条边再各自给几何。
  const base = /\.resize-handle\.top::before[^{]*\{([^}]*)\}/.exec(PANEL_CSS);
  assert.ok(base, '缺少平边 ::before 的基础规则');
  assert.match(base[1], /opacity:\s*0/, '平边强调线默认应不可见，只在 hover/拖动时出现');
  for (const side of ['top', 'bottom', 'left', 'right']) {
    const rule = ruleBody('.resize-handle.' + side + '::before');
    assert.ok(rule, `.resize-handle.${side}::before 缺少几何规则（这条边就没有强调线了）`);
  }
  assert.ok(
    /\.resize-handle:hover::before[^{]*\{[^}]*opacity:\s*\.?\d/.test(PANEL_CSS),
    '.resize-handle:hover::before 应把强调线显示出来'
  );
});

test('平边不再画角落 L 形抓手（否则上下边会顶着两个小直角）', () => {
  // 这四条写在同一个选择器列表里（`.resize-handle.top::after, … { display:none }`），
  // ruleBody() 要求选择器紧贴 `{`，因此这里直接对整段 CSS 做匹配。
  const muted = /\.resize-handle\.top::after[^{]*\{[^}]*display:\s*none/.exec(PANEL_CSS);
  assert.ok(muted, ' .resize-handle.top::after 应 display:none，改用 ::before 强调线');
  for (const side of ['top', 'bottom', 'left', 'right']) {
    assert.ok(muted[0].includes('.resize-handle.' + side + '::after'), '平边 ' + side + ' 的 L 形抓手也要一起关掉');
  }
});

// ---- 嵌入态：唯一可调宽度的手柄必须看得见、且不啃对话区 ----

test('嵌入态保留可见的左缘手柄（这是整列唯一的宽度入口）', () => {
  const emb = ruleBody('.panel.embedded .resize-handle.left');
  assert.ok(emb, '嵌入态必须保留左缘手柄，否则整列宽度完全无从调节');
  assert.match(emb, /display:\s*block/);
  const width = resolveLen(/width:([^;]*)/.exec(emb)?.[1] || '', RF_EDGE);
  assert.ok(width !== null && width >= RF_EDGE, '嵌入态左缘手柄不应窄于浮层的 --rf-edge：' + width);
  assert.ok(ruleBody('.panel.embedded .resize-handle.left::after'), '嵌入态左缘手柄必须有自己的可见抓手');
});

test('嵌入态 .p-body 不再为右缘手柄右缩（嵌入态没有右缘手柄）', () => {
  const emb = ruleBody('.panel.embedded .p-body');
  assert.ok(emb, '缺少 .panel.embedded .p-body 规则');
  const margin = /margin-right:\s*([^;]+)/.exec(emb);
  assert.ok(margin, '嵌入态应显式把 .p-body 的右边距归零');
  assert.equal(/^0(px)?$/.test(margin[1].trim()), true, '嵌入态右边距应为 0（对话区本来就窄）：' + margin[1]);
});

test('嵌入态窄栏里快捷提示单行横滚（不折行白吃对话区高度）', () => {
  const rule = ruleBody('.panel.embedded .quick-prompts');
  assert.ok(rule, '缺少 .panel.embedded .quick-prompts 规则');
  assert.match(rule, /flex-wrap:\s*nowrap/, '窄栏里 4 个按钮折成两行会吃掉约 30px 对话区');
  assert.match(rule, /overflow-x:\s*auto/, '不折行就必须能横向滚动，否则按钮被裁掉');
  assert.match(ruleBody('.panel.embedded .quick-prompt') || '', /flex:\s*0\s+0\s+auto/, '按钮不能收缩，否则文字被压扁');
});
