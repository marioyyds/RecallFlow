// agent 的墙钟预算：软截止只提醒一次，硬截止必须收尾。
//
// 背景（480 条实测）：15 条任务在外部 300s/420s 超时线仍 running，
// 因为扩展内 agent 不知道调用方的墙钟。纯函数先钉住边界，避免"到点还在开新流程"。
import test from 'node:test';
import assert from 'node:assert/strict';

import { deadlineDecision } from '../lib/assistant/agent.js';
import { deadlineForTask } from '../integrations/webarena/config.mjs';

test('deadlineDecision：未到软/硬截止继续', () => {
  assert.equal(deadlineDecision({ now: 100, deadlineAt: 1000, wrapUpAt: 700, wrapUpSent: false }), 'continue');
});

test('deadlineDecision：到软截止只提醒一次', () => {
  assert.equal(deadlineDecision({ now: 700, deadlineAt: 1000, wrapUpAt: 700, wrapUpSent: false }), 'wrap-up');
  assert.equal(deadlineDecision({ now: 800, deadlineAt: 1000, wrapUpAt: 700, wrapUpSent: true }), 'continue');
});

test('deadlineDecision：到硬截止必须 stop（且优先于软提醒）', () => {
  assert.equal(deadlineDecision({ now: 1000, deadlineAt: 1000, wrapUpAt: 700, wrapUpSent: false }), 'stop');
  assert.equal(deadlineDecision({ now: 1200, deadlineAt: 1000, wrapUpAt: 700, wrapUpSent: true }), 'stop');
});

test('deadlineDecision：未配置预算时不启用（面板路径不变）', () => {
  assert.equal(deadlineDecision({ now: 1e12 }), 'continue');
  assert.equal(deadlineDecision({ now: 1e12, deadlineAt: 0, wrapUpAt: 0 }), 'continue');
});

test('deadlineForTask：硬截止早于外部 timeout，软截止在 3/4 处', () => {
  const { deadlineAt, wrapUpAt } = deadlineForTask({ timeoutMs: 300000, startedMs: 1000 });
  assert.ok(deadlineAt < 1000 + 300000, '硬截止必须早于外部 timeout');
  assert.ok(deadlineAt > wrapUpAt, '硬截止晚于软提醒');
  assert.equal(wrapUpAt, 1000 + 225000);
});

test('deadlineForTask：很短的 timeout 也保证软截止在硬截止之前', () => {
  const { deadlineAt, wrapUpAt } = deadlineForTask({ timeoutMs: 60000, startedMs: 0 });
  assert.ok(wrapUpAt < deadlineAt);
  assert.ok(wrapUpAt > 0 && deadlineAt > 0);
});
