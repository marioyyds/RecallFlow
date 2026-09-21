import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVerificationReflection, buildStuckReflection } from '../lib/assistant/verifier.js';

test('verification reflection includes reason, missing and suggestion', () => {
  const r = buildVerificationReflection({ ok: false, reason: '目标页未打开', missing: '目标页未加载', suggestion: '重新 open_tab' });
  assert.ok(r.includes('未通过'));
  assert.ok(r.includes('目标页未加载'));
  assert.ok(r.includes('重新 open_tab'));
});

test('stuck reflection suggests alternative strategies', () => {
  const r = buildStuckReflection('连续 3 次无进展');
  assert.ok(r.includes('连续 3 次无进展'));
  assert.ok(r.includes('role+name') || r.includes('CDP'));
});
