// 编排器的纯函数测试（integrations/webarena/run.mjs）。
//
// 只测能在无浏览器、无 Docker、无 API Key 的情况下确定的部分：
// 「复用已有桥接服务」的告警文案。这条告警存在的理由是"静默复用会把旧代码的评测结果
// 当成本轮结果"—— 所以字段齐全度与是否给出告警必须钉住。
import test from 'node:test';
import assert from 'node:assert/strict';

import { describeBridgeReuse } from '../integrations/webarena/run.mjs';

test('describeBridgeReuse：已有服务时点名 pid 与扩展状态', () => {
  const msg = describeBridgeReuse({ pid: 4321, ws: true });
  assert.match(msg, /pid=4321/);
  assert.match(msg, /扩展已连上/);
  assert.match(msg, /旧代码/);
  assert.match(msg, /重启/);
});

test('describeBridgeReuse：没有 pid 也不假装知道', () => {
  const msg = describeBridgeReuse({ ok: true, ws: false });
  assert.match(msg, /pid 未知/);
  assert.match(msg, /扩展未连上/);
});

test('describeBridgeReuse：服务不在时不给告警（别把正常启动说成复用）', () => {
  assert.equal(describeBridgeReuse({ up: false, error: 'ECONNREFUSED' }), '');
  assert.equal(describeBridgeReuse(null), '');
  assert.equal(describeBridgeReuse({}), '');
});
