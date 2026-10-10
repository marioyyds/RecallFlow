// 完成校验器的**成本策略**门禁。
//
// ## 为什么值得单独测
//
// `shouldVerifyCompletion` 决定"什么时候额外花一次模型调用做独立校验"。
// 它答错两边的代价都不小：
//   · 放宽（对闲聊/知识库任务也校验）→ **每次收尾都白花一次调用**，而这类任务占多数；
//   · 收紧（该校验时不校验）→ 回到"模型自称完成就采信"，那正是校验器存在的理由。
// 原先它是模块内私有函数、**零测试覆盖** —— 这正是本轮实测校验器成本时发现的缺口。
//
// ## 实测成本（真模型探针，用于校准"它到底贵不贵"）
//
//   剧本                总请求  Agent  校验器  否决
//   site-search（只读）      6      5      1     0
//   recover-from-rejection  18     16      2     1（**合理**：回执显示的是选项 value，
//                                                    与声称的商品名不一致，模型补充说明后通过）
//
// 也就是说校验器约占 **11%~17%** 的请求量，且否决是有依据的 ——
// 早先"失败恢复那一轮成本主要来自校验器反复要证据"的说法**与数据不符**，已更正。
import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldVerifyCompletion } from '../lib/assistant/agent.js';
import { INTENTS } from '../lib/assistant/intent-router.js';

const SETTINGS = { apiKey: 'k' };

test('只对会操作页面的意图校验：闲聊 / 知识库类任务一律不校验', () => {
  // 这类任务占多数，而它们没有"页面状态是否真的变了"可验 —— 校验等于白花一次调用
  for (const intent of [INTENTS.CHAT, INTENTS.KNOWLEDGE, undefined, null, '']) {
    assert.equal(
      shouldVerifyCompletion(intent, 5, SETTINGS),
      false,
      '意图「' + intent + '」不该触发校验'
    );
  }
  assert.equal(shouldVerifyCompletion(INTENTS.BROWSER, 5, SETTINGS), true, '浏览器任务应校验');
  assert.equal(shouldVerifyCompletion(INTENTS.RESEARCH, 5, SETTINGS), true, '研究任务应校验');
  // 意图常量本身也钉一下：改名字会让"该校验的没校验"变成静默的
  assert.equal(INTENTS.BROWSER, 'browser_task');
  assert.equal(INTENTS.RESEARCH, 'research_task');
});

test('没调用过任何工具就不校验（没有可验的动作）', () => {
  assert.equal(shouldVerifyCompletion(INTENTS.BROWSER, 0, SETTINGS), false);
  assert.equal(shouldVerifyCompletion(INTENTS.BROWSER, undefined, SETTINGS), false);
});

test('用户可以关掉它；没配 API Key 也不能调（否则会静默失败）', () => {
  assert.equal(shouldVerifyCompletion(INTENTS.BROWSER, 5, { apiKey: 'k', verifierEnabled: false }), false);
  assert.equal(shouldVerifyCompletion(INTENTS.BROWSER, 5, { verifierEnabled: true }), false, '缺 apiKey 时不调');
  assert.equal(shouldVerifyCompletion(INTENTS.BROWSER, 5, null), false);
  assert.equal(shouldVerifyCompletion(INTENTS.BROWSER, 5, undefined), false);
});

test('这条门禁本身有牙齿：「永远校验」与「永远不校验」都必须被判为不合格', () => {
  const cases = [INTENTS.CHAT, INTENTS.BROWSER];
  const always = () => true;
  const never = () => false;
  assert.notDeepEqual(
    cases.map((i) => always(i, 5, SETTINGS)),
    cases.map((i) => shouldVerifyCompletion(i, 5, SETTINGS)),
    '「永远校验」与真实策略不同 —— 说明断言真的在区分意图'
  );
  assert.notDeepEqual(
    [INTENTS.BROWSER, INTENTS.RESEARCH].map((i) => never(i, 5, SETTINGS)),
    [INTENTS.BROWSER, INTENTS.RESEARCH].map((i) => shouldVerifyCompletion(i, 5, SETTINGS)),
    '「永远不校验」与真实策略不同'
  );
});
