import test from 'node:test';
import assert from 'node:assert/strict';

import { staleClickTargetFailure } from '../lib/application/page/commands/actions.ts';

test('点击目标已脱离 DOM 时返回 STALE_TARGET，而不是成功', () => {
  assert.deepEqual(staleClickTargetFailure({ isConnected: false }), {
    ok: false,
    code: 'STALE_TARGET',
    error: '目标元素已从页面移除，ref/selector 可能已过期；请重新观察页面后重试。',
  });
});

test('仍在 DOM 或旧测试桩没有 isConnected 时不误伤', () => {
  assert.equal(staleClickTargetFailure({ isConnected: true }), null);
  assert.equal(staleClickTargetFailure({}), null);
});
