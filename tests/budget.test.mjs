// 预算语义：**没有进度墙，只有成本兜底**（对齐 DSH）。
//
// dsh-agent-loop 里既没有 maxTurns 也没有 maxToolCalls，唯一的限制常量是并发度；
// 结束靠 complete_task / 最终回答 / 用户中断，压缩与溢出负责让上下文可持续。
//
// RecallFlow 原先有三道**进度**墙（maxModelTurns / maxToolCalls / maxDurationMs）。
// 它们惩罚的是「任务确实很长」而不是「任务失控」：实测一次正常的「24 类工具冒烟测试」
// 被工具墙硬停，用户被迫连说两次「继续」。这里锁住「它们不会再回来」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { AGENT_BUDGET_DEFAULTS, tokenBudgetExceeded } from '../lib/assistant/agent.js';
import { TOOL_REGISTRY } from '../lib/assistant/tools.js';
import { resolveIntent, INTENTS } from '../lib/assistant/intent-router.js';
import { estimateTokens } from '../lib/assistant/context.js';

const readSource = (p) => fs.readFileSync(p, 'utf8').split('\n').map((l) => l.replace(/\r$/, '')).join('\n');

// ---------------------------------------------------------------- 进度墙必须消失

test('不再存在任何进度上限：轮数 / 工具数 / 任务时长', () => {
  for (const key of ['maxModelTurns', 'maxToolCalls', 'maxDurationMs']) {
    assert.ok(!(key in AGENT_BUDGET_DEFAULTS), key + ' 不该再出现在预算默认值里 —— 它是进度墙，不是成本兜底');
  }
});

test('主循环不设轮数上限，而是无限循环 + 靠结束条件退出', () => {
  const src = readSource('lib/assistant/agent.js');
  assert.match(src, /for \(let iter = resumeIteration; ; iter\+\+\)/, '主循环应为无限循环');
  assert.ok(!/iter < effectiveModelTurns/.test(src), '不该再有轮数上界');
  assert.ok(!/reason: 'maxModelTurns'/.test(src), '不该再有「达到最大推理轮数」的终止路径');
  assert.ok(!/reason: 'maxToolCalls'/.test(src), '不该再有「工具调用达到安全上限」的终止路径');
  assert.ok(!/reason: 'maxDurationMs'/.test(src), '不该再有「超过安全时限」的终止路径');
});

test('按意图分配轮数/工具数的表已移除（留一个没人读的表会让人以为仍受控）', () => {
  const src = readSource('lib/assistant/intent-router.js');
  assert.ok(!/export const INTENT_TURN_DEFAULTS/.test(src), '不该再导出轮数默认值表');
});

test('设置页不再暴露已失效的「工具调用上限 / 推理轮数上限」输入框', () => {
  const html = readSource('options.html');
  assert.ok(!/id="budget-tools"/.test(html), '输入框还在，但值已经没人读了 —— 那是"静默无效"的设置');
  assert.ok(!/id="budget-turns"/.test(html));
  assert.match(html, /id="budget-tokens"/, '成本上限仍应可配置');
});

// ---------------------------------------------------------------- 保留：成本兜底

test('AGENT_BUDGET_DEFAULTS: 含 token 成本上限且为有限正数', () => {
  assert.ok('maxTotalTokens' in AGENT_BUDGET_DEFAULTS, '应定义 maxTotalTokens');
  const v = AGENT_BUDGET_DEFAULTS.maxTotalTokens;
  assert.ok(Number.isFinite(v) && v > 0, '应为有限正数，实际 ' + v);
});

test('成本上限必须高于「正常任务的实际累计」——按实测推导，不能拍脑袋', () => {
  // totalTokens 累加的是每次请求的用量，而每轮都重发整段上下文 →
  // 正常任务的累计就远超「单轮用量 × 轮数」的直觉。
  // 这里用实测的工具定义体积推导一个下限：工具每轮都发，是每轮请求的**确定**组成部分。
  const byName = new Map(TOOL_REGISTRY.map((t) => [t.name, t]));
  const browserTools = (resolveIntent(INTENTS.BROWSER).allowedTools || [])
    .map((n) => byName.get(n))
    .filter(Boolean)
    .map((t) => t.openai);
  const toolsPerTurn = estimateTokens(JSON.stringify(browserTools));
  assert.ok(toolsPerTurn > 5000, '前置：浏览器工具定义应有可观体积，实测 ' + toolsPerTurn);

  // 没有轮数上限之后，正常任务的轮数不再有已知上界 —— 因此只用一个保守的
  // 「长任务」轮数（60 轮）推下限，保证正常的长任务不会被成本墙半路掐断。
  const floor = toolsPerTurn * 60 * 2;
  assert.ok(
    AGENT_BUDGET_DEFAULTS.maxTotalTokens > floor,
    'token 上限 ' + AGENT_BUDGET_DEFAULTS.maxTotalTokens + ' 低于长任务累计下限 ' + floor + '（工具 ' + toolsPerTurn + ' tokens/轮 × 60 轮 × 2）'
  );
});

test('tokenBudgetExceeded: 未达上限不触发', () => {
  assert.equal(tokenBudgetExceeded(999, { maxTotalTokens: 1000 }), false);
});

test('tokenBudgetExceeded: 达到或超过上限即触发（含恰好等于）', () => {
  assert.equal(tokenBudgetExceeded(1000, { maxTotalTokens: 1000 }), true);
  assert.equal(tokenBudgetExceeded(1001, { maxTotalTokens: 1000 }), true);
});

test('tokenBudgetExceeded: 上限为 0 / 负数 / 非数字 = 不限制', () => {
  for (const cap of [0, -1, NaN, undefined, null, 'abc']) {
    assert.equal(tokenBudgetExceeded(99999999, { maxTotalTokens: cap }), false, '上限 ' + String(cap) + ' 应视为不限制');
  }
  assert.equal(tokenBudgetExceeded(99999999, null), false);
  assert.equal(tokenBudgetExceeded(99999999, undefined), false);
});

test('tokenBudgetExceeded: 用量为 0 / 负数 / 非数字时不该误判为超限', () => {
  // 首轮之前 totalTokens 为 0；若把 0 当成超限就会「一启动就停」。
  assert.equal(tokenBudgetExceeded(0, { maxTotalTokens: 1000 }), false);
  assert.equal(tokenBudgetExceeded(-5, { maxTotalTokens: 1000 }), false);
  assert.equal(tokenBudgetExceeded(NaN, { maxTotalTokens: 1000 }), false);
});

test('tokenBudgetExceeded: 字符串数字按数值处理', () => {
  assert.equal(tokenBudgetExceeded('1500', { maxTotalTokens: '1000' }), true);
});

test('成本兜底的提示语必须说清它是**花费**而非「额度用完」', () => {
  const src = readSource('lib/assistant/agent.js');
  assert.match(src, /这与「做了多少事」无关 —— 它是花费兜底/, '否则用户会以为又是「工具额度」那种墙');
});

// ---------------------------------------------------------------- 接线

test('接线：守卫只有 ok / reflect 两种消费分支，不得再摘除工具或终止任务', () => {
  const src = readSource('lib/assistant/agent.js');
  assert.match(src, /decision\.level === 'reflect'/, '应保留 reflect 分支');
  assert.ok(!/decision\.level === 'disable'/.test(src), '不该再摘除工具');
  assert.ok(!/decision\.level === 'stop'/.test(src), '不该再因守卫终止任务');

  // 唯一允许的摘除是**资源型工具自己声明触顶**（如 open_tab 开新页预算用尽，res.blocked=true）——
  // 那对应 DSH 的「每个工具分别提供自己的限时」，是工具自己的边界，不是守卫替模型做决定。
  // 因此只断言**守卫那条分支**里不出现摘除。
  const at = src.indexOf("decision.level === 'reflect'");
  const guardBlock = src.slice(at, at + 900);
  assert.ok(!/disabledTools\.add/.test(guardBlock), '守卫分支里不该摘除工具');
  assert.ok(!/RUN_STATUS\.TIMEOUT/.test(guardBlock), '守卫分支里不该终止任务');
});

test('接线：并发上限存在（DSH 里唯一的数量闸门）', () => {
  const src = readSource('lib/assistant/parallel-tools.js');
  assert.match(src, /DEFAULT_MAX_BATCH\s*=\s*\d+/, '并行批次必须有上限');
});
