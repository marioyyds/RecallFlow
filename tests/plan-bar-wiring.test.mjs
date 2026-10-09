// 执行计划条位置的源码级门禁。
//
// 为什么需要：把计划从「助手消息开头」挪到「输入框上方」时，有三处很容易漏，
// 而漏掉都不会报错、测试也不会红，只是功能静默失效：
//   ① 元素创建晚于 renderConversation() —— 回填落空，重开面板时计划条是空的；
//   ② 忘记从消息正文里摘掉 planHtml —— 计划会同时出现在消息和计划条里（重复）；
//   ③ 忘记在 removePanel 里置空 —— 面板隐藏期间助手仍在跑，renderPlan 会写进脱离文档的节点。
// 与前几轮的「对 const 赋值」「请求前缀稳定性」同一类：静态可查、但没人查。
//
// 按行切源码前先剥 \r（Windows 工作区是 CRLF，精确比较会因为行尾 \r 全部落空）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync('lib/page/chat.js', 'utf8');
const lines = src.split('\n').map((l) => l.replace(/\r$/, ''));

function indexOfLine(pattern, from = 0) {
  const i = lines.findIndex((l, idx) => idx >= from && l.includes(pattern));
  assert.notEqual(i, -1, '找不到：' + pattern);
  return i;
}

function sliceBetween(startMarker, endMarker) {
  const s = indexOfLine(startMarker);
  const e = indexOfLine(endMarker, s + 1);
  return lines.slice(s, e).join('\n');
}

test('计划渲染到输入框上方的计划条，而不是助手消息里', () => {
  const fn = sliceBetween('function renderPlan', 'function summarizeToolParts');
  assert.match(fn, /planBar/, 'renderPlan 应写入 planBar');
  assert.ok(!/pendingAiMsg/.test(fn), 'renderPlan 不应再往助手消息里插计划');
});

test('计划条必须挂到输入框（cmd-box）之前', () => {
  const cmdAreaStart = indexOfLine('const cmdArea = document.createElement');
  const planAppend = indexOfLine('cmdArea.appendChild(planBar)', cmdAreaStart);
  const cmdWrapAppend = indexOfLine('cmdArea.appendChild(cmdWrap)', cmdAreaStart);
  assert.ok(
    planAppend < cmdWrapAppend,
    '计划条必须 appendChild 在 cmdWrap（输入框）之前，否则它会显示在输入框下方'
  );
});

test('计划条元素必须在构造期的 renderConversation() 之前创建（否则回填落空）', () => {
  // 注意：openPanel 里还有几处 renderConversation() 在**事件处理器内部**（撤销、
  // 重新生成等），它们在构造期不执行，不能作为判据。真正跑在构造期的是紧挨
  // restoreStreamingUI() 之前那一次 —— 以它为锚点。
  const open = indexOfLine('function openPanel');
  const restore = indexOfLine('restoreStreamingUI();', open);
  let setupRender = -1;
  for (let i = restore; i > open; i--) {
    if (lines[i].includes('renderConversation();')) {
      setupRender = i;
      break;
    }
  }
  assert.notEqual(setupRender, -1, 'openPanel 构造期应调用 renderConversation()');
  const created = indexOfLine('planBar = document.createElement', open);
  assert.ok(
    created < setupRender,
    'planBar 的创建必须早于构造期的 renderConversation()（第 ' + (setupRender + 1) + ' 行），否则回填时 planBar 还是 null'
  );
});

test('消息正文里不再渲染计划（避免与计划条重复）', () => {
  const render = sliceBetween('function renderConversation', 'function renderPlan');
  assert.ok(!/planHtml/.test(render), 'renderConversation 不应再调用 planHtml');
  assert.match(render, /renderPlan\(/, 'renderConversation 应把最近一条计划回填到计划条');
});

test('planHtml 已被删除（不然是死代码）', () => {
  assert.ok(!lines.some((l) => l.includes('function planHtml')), 'planHtml 已无调用方，应删除');
  assert.ok(!src.includes('planHtml('), '不应残留 planHtml 调用');
});

test('removePanel 里置空 planBar（面板隐藏期间助手仍在跑）', () => {
  const fn = sliceBetween('function removePanel', 'function showBubble');
  assert.match(fn, /planBar = null/, 'removePanel 应置空 planBar，避免写进脱离文档的节点');
});

test('新一轮开始时先清掉上一轮的计划条', () => {
  // 取最后一个 `lastPlan = [];` —— 第一个是模块顶部的 `let lastPlan = []` 声明。
  const occurrences = lines.map((l, i) => (l.includes('lastPlan = [];') ? i : -1)).filter((i) => i >= 0);
  assert.ok(occurrences.length >= 1, '找不到 lastPlan 的重置点');
  const resetAt = occurrences[occurrences.length - 1];
  const before = lines.slice(Math.max(0, resetAt - 4), resetAt).join('\n');
  assert.match(before, /renderPlan\(\[\]\)/, '新一轮开始应清空计划条，等本轮的 update_plan 到达再显示');
});

test('计划条样式存在且限制高度（步骤多时不能把输入框顶下去）', () => {
  const css = fs.readFileSync('lib/page/panel-css.js', 'utf8');
  assert.match(css, /\.agent-plan-bar\s*\{/, '缺少 .agent-plan-bar 样式');
  const block = /\.agent-plan-bar\s*\{([^}]*)\}/.exec(css);
  assert.match(block[1], /max-height/, '计划条应限制高度并允许自身滚动');
  assert.match(block[1], /overflow-y\s*:\s*auto/, '计划条应允许自身滚动');
});
