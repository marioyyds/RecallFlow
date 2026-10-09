// 执行计划条位置与折叠态的源码级门禁。
//
// 为什么需要：计划条的位置与生命周期里有几处很容易漏，
// 而漏掉都不会报错、测试也不会红，只是功能静默失效：
//   ① 元素创建晚于 renderConversation() —— 回填落空，重开面板时计划条是空的；
//   ② 忘记从消息正文里摘掉 planHtml —— 计划会同时出现在消息和计划条里（重复）；
//   ③ 忘记在 removePanel 里置空 —— 面板隐藏期间助手仍在跑，renderPlan 会写进脱离文档的节点；
//   ④ 挂载点挪错位置 —— 掉到对话下方，或又挤回输入框上方那堆条里。
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

test('计划条挂在**底部控件区的第一格**（快捷指令之上）', () => {
  // 位置试过四轮：助手消息开头（会滚走）→ 对话区顶部（压住内容）→ 紧贴输入框
  // （和 4 条挤在一起）→ 现在是底部控件区的第一格。
  const cmdAreaStart = indexOfLine('const cmdArea = document.createElement');
  const planAppend = indexOfLine('cmdArea.appendChild(planBar);', cmdAreaStart);
  const quickAppend = indexOfLine('cmdArea.appendChild(quickWrap);', cmdAreaStart);
  assert.notEqual(planAppend, -1, '找不到计划条的挂载点');
  assert.notEqual(quickAppend, -1, '找不到快捷指令的挂载点');
  assert.ok(planAppend < quickAppend, '计划条应在快捷指令之上');
  // 也不该挂在 panel 上：那会压在对话**内容**上方（计划是过程，过程不该占内容区的版面）。
  assert.ok(
    !lines.some((l) => l.trim() === 'panel.appendChild(planBar);'),
    '不该挂在 panel 上 —— 那会压住对话内容'
  );
});

test('计划条的展开状态必须是**三态**，否则自动折叠永远不触发', () => {
  // 踩过的坑：写成单一布尔且初值 true，于是 `collapsed = allDone && !planExpanded`
  // 恒为 false —— 折叠永远不会发生。截图里 8/8 全划掉却仍整块铺开，就是这个 bug。
  assert.match(src, /let planExpanded = null;/, '初值必须是「未表态」的 null，不能是 true');
  const fn = sliceBetween('function renderPlan', 'function summarizeToolParts');
  assert.match(fn, /if \(!allDone\) planExpanded = null;/, '新一轮开始要清掉手动状态，否则这一轮跑完不会折叠');
  assert.match(fn, /const collapsed = allDone && planExpanded !== true;/, '未表态时完成即折叠');
  // 点击处理器在 openPanel 里（不在 renderPlan 内），所以对全文断言。
  assert.match(src, /planExpanded = planBar\.classList\.contains\('collapsed'\);/, '点击切换要写回显式选择');
});

test('计划条全部完成后折叠成一行（同样的内容对话里已经有了，不该继续占高度）', () => {
  const fn = sliceBetween('function renderPlan', 'function summarizeToolParts');
  assert.match(fn, /allDone/, '需要判断「是否全部完成」');
  assert.match(fn, /classList\.toggle\('collapsed'/, '完成态应加 collapsed 类');
  assert.match(fn, /步已完成/, '折叠后仍要能看出做了多少');
  assert.ok(!/\bplanExpanded = true;\s*\n\s*if \(allDone\)/.test(fn), '不该无条件展开');
});

test('计划条：未完成时保持展开（不能因为上一轮折叠过就看不见这一轮的计划）', () => {
  const fn = sliceBetween('function renderPlan', 'function summarizeToolParts');
  assert.match(fn, /if \(!allDone\) planExpanded = null;/, '未完成时应清掉手动折叠状态');
  assert.match(fn, /const collapsed = allDone && planExpanded !== true;/, '未完成时 collapsed 必为 false');
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
