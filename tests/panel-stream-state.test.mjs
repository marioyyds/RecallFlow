import test from 'node:test';
import assert from 'node:assert/strict';

import { createPanelStreamState } from '../lib/page/panel-stream-state.ts';

test('chunk 累积正文与当前叙述段', () => {
  const state = createPanelStreamState();
  state.appendChunk('你');
  state.appendChunk('好');
  assert.equal(state.content, '你好');
  assert.equal(state.narration, '你好');
  assert.equal(state.started, true);
  assert.equal(state.responseText, '你好');
});

test('叙述段定稿后进入 parts，最终正文仍可独立读取', () => {
  const state = createPanelStreamState();
  state.appendChunk('先说一句');
  assert.equal(state.flushNarration(), '先说一句');
  state.appendChunk('最终答案');

  assert.equal(state.narration, '最终答案');
  assert.deepEqual(state.parts, [{ type: 'narration', text: '先说一句' }]);
  assert.equal(state.responseText, '最终答案');
  assert.equal(state.hasPartial(), true);
});

test('恢复快照复制 parts，避免把外部数组继续挂进运行状态', () => {
  const state = createPanelStreamState();
  const source = {
    content: '正文',
    narration: '进行中',
    parts: [{ type: 'notice', text: '已开始' }],
  };
  state.restore(source);
  source.parts[0].text = '外部修改';

  assert.equal(state.content, '正文');
  assert.equal(state.narration, '进行中');
  assert.equal(state.started, true);
  assert.deepEqual(state.parts, [{ type: 'notice', text: '已开始' }]);
});

test('校验提示只在显式 commit 时入库', () => {
  const state = createPanelStreamState();
  const notice = { type: 'notice', text: '通过', terminal: true };
  state.setVerifyPass(notice);
  assert.deepEqual(state.parts, []);
  state.commitVerifyPass();
  assert.deepEqual(state.parts, [notice]);
  assert.equal(state.verifyPass, null);
});

test('reset 清空所有运行态并保留对象身份', () => {
  const state = createPanelStreamState();
  state.appendChunk('x');
  state.appendPart({ type: 'tool-call' });
  state.setVerifyPass({ type: 'notice' });
  state.markBudgetStopped();
  state.reset();

  assert.equal(state.content, '');
  assert.equal(state.narration, '');
  assert.equal(state.started, false);
  assert.deepEqual(state.parts, []);
  assert.equal(state.verifyPass, null);
  assert.equal(state.budgetStopped, false);
});
