// 上下文治理阈值的门禁。
//
// 为什么值得单独一个文件：这些数字原先散在 agent.js 的五处，每一处都配着
// "为什么是这个值"的好注释，但**没有任何一处能回答"当前这套参数是多少"** ——
// 于是它们事实上是硬编码：`settings.agentBudget` 只接得住预算，接不住这些。
// 集中之后，这里用字面量把它们钉住（与 tool-guard 那条同款理由：
// 期望值必须写死，写成 `=== 常量本身` 就成了恒真断言）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTEXT_TUNING } from '../lib/assistant/context-tuning.js';
import { SESSION_MESSAGE_MAX_CHARS, SESSION_MAX_TAIL_MESSAGES } from '../lib/assistant/agent.js';

test('阈值必须被字面量钉住（改一个数就会红）', () => {
  assert.equal(CONTEXT_TUNING.collapseTokens, 16000);
  assert.equal(CONTEXT_TUNING.collapseKeepFull, 6);
  assert.equal(CONTEXT_TUNING.collapseHeadChars, 300);
  assert.equal(CONTEXT_TUNING.spillResultChars, 6000);
  assert.equal(CONTEXT_TUNING.spillInlineChars, 3000);
  assert.equal(CONTEXT_TUNING.sessionMessageMaxChars, 12000);
  assert.equal(CONTEXT_TUNING.sessionMaxTailMessages, 39);
});

test('两道闸的先后关系必须成立：先暂存（6000）再折叠，且暂存内联段小于阈值', () => {
  // 这不是凑数：这两个数是"同一件事的两道闸"。若有人把 spillResultChars 调到
  // 小于 collapseHeadChars，就会出现"结果先被折叠得只剩 300 字、然后才判断要不要暂存"
  // 的荒谬顺序 —— 存进去的已经是残片，expand_result 取回的也就没意义了。
  assert.ok(
    CONTEXT_TUNING.spillResultChars > CONTEXT_TUNING.spillInlineChars,
    '暂存阈值必须大于内联保留长度，否则"全文"比"摘要"还短'
  );
  assert.ok(
    CONTEXT_TUNING.spillInlineChars > CONTEXT_TUNING.collapseHeadChars,
    '内联保留段必须大于折叠后的头部，否则暂存反而丢信息'
  );
});

test('agent.js 的导出常量确实来自集中配置（防止两处各改各的）', () => {
  // 抽完之后 agent.js 只是引用。若有人在 agent.js 里又写死一个数，
  // 这里会红 —— 那正是"散落"回来的第一步。
  assert.equal(SESSION_MESSAGE_MAX_CHARS, CONTEXT_TUNING.sessionMessageMaxChars);
  assert.equal(SESSION_MAX_TAIL_MESSAGES, CONTEXT_TUNING.sessionMaxTailMessages);
});

test('阈值表是冻结的（运行时不许被顺手改掉）', () => {
  assert.equal(Object.isFrozen(CONTEXT_TUNING), true, '冻结是为了让"运行时偷偷改阈值"直接失败');
});
