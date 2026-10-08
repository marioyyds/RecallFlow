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

import { PANEL_CSS } from '../lib/page/panel-css.js';

/** 取出某个选择器的规则体（要求 `{` 紧跟选择器，故 `.panel.dark` 不会误配 `.panel`）。 */
function ruleBody(selector) {
  const m = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}').exec(PANEL_CSS);
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
