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

test('计划条的展开状态必须是**三态**，且默认收起', () => {
  // 踩过的坑（截图实证）：写成「单一布尔 + 初值 true」时，
  // `collapsed = allDone && !planExpanded` 恒为 false —— 收起分支永远进不去，
  // 8/8 全划掉却仍整块铺开。
  //
  // 现在的契约更进一步：**默认就是收起的一行**（不再依赖「全部完成」才收）——
  // 因为它先前用「限高 + 内层滚动条」处理步骤过多，那个方案已被否掉。
  assert.match(src, /let planExpanded = null;/, '初值必须是「未表态」的 null，不能是 true');
  const fn = sliceBetween('function renderPlan', 'function summarizeToolParts');
  assert.match(fn, /const collapsed = planExpanded !== true;/, '未表态时必须收起');
  // 点击处理器在 openPanel 里（不在 renderPlan 内），所以对全文断言。
  assert.match(src, /planExpanded = planBar\.classList\.contains\('collapsed'\);/, '点击切换要写回显式选择');
});

test('计划条只在「完成 ↔ 进行中」切换时回到默认，不打断用户的展开', () => {
  const fn = sliceBetween('function renderPlan', 'function summarizeToolParts');
  // 若写成 `if (!allDone) planExpanded = null;`，用户展开后每一次计划更新都会把它收回去。
  assert.match(fn, /if \(allDone !== planWasAllDone\) planExpanded = null;/, '只在状态切换时归零');
  assert.ok(!/if \(!allDone\) planExpanded = null;/.test(fn), '不该每次未完成都强制归零');
});

test('计划条：收起那一行必须带上「进度 + 当前步骤」（信息量不能因收起而丢）', () => {
  const fn = sliceBetween('function renderPlan', 'function summarizeToolParts');
  assert.match(fn, /doneCount \+\s*'\/' \+\s*total/, '要显示进度');
  assert.match(fn, /current \? ' · ▶ ' \+/, '要显示当前正在做的那一步');
  assert.match(fn, /步已完成/, '全部完成时给出完成文案');
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

test('计划条样式**不得**限定高度或内层滚动 —— 改为收起/展开处理步骤过多', () => {
  // 原先 `.agent-plan-bar { max-height: 132px; overflow-y: auto }`：
  // 步骤一多它就变成一个小滚动框，既难看又要二次滚动。
  // 用户明确要求「换一种」，于是改为「默认收成一行 / 点击展开全部」，
  // 展开时不设高度上限 —— 因此任何情况下都不该再有内层滚动条。
  const css = fs.readFileSync('lib/page/panel-css.js', 'utf8');
  const block = /\.agent-plan-bar\s*\{([^}]*)\}/.exec(css);
  assert.ok(block, '缺少 .agent-plan-bar 样式');
  assert.ok(!/max-height/.test(block[1]), '计划条不该再限高：' + block[1].trim());
  assert.ok(!/overflow-y\s*:\s*auto/.test(block[1]), '不该再有内层滚动条：' + block[1].trim());
  assert.match(css, /\.agent-plan-bar\.collapsed \.agent-plan-items \{ display: none; \}/, '靠收起隐藏列表，而不是滚动');
});
