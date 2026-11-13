import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyActionResult } from '../lib/application/agent/action-verify.ts';

const before = {
  url: 'https://huggingface.co/models',
  fingerprint: 'fp-1',
  elements: [{ name: '搜索' }],
  text: 'Models',
};
const afterOk = {
  url: 'https://huggingface.co/models?search=on-device',
  fingerprint: 'fp-2',
  elements: [{ name: '搜索' }, { name: '结果 A' }, { name: '结果 B' }],
  text: 'Models 78 结果 A 结果 B',
};

test('动作校验：URL 与指纹都变化时判 verified', () => {
  const result = verifyActionResult(before, afterOk, {
    urlChanged: true,
    fingerprintChanged: true,
    minElementDelta: 1,
  });
  assert.equal(result.verdict, 'verified');
  assert.equal(result.failures.length, 0);
});

test('动作校验：URL 没变判 mismatch，并给出证据', () => {
  const result = verifyActionResult(before, { ...before, fingerprint: 'fp-2' }, { urlChanged: true });
  assert.equal(result.verdict, 'mismatch');
  assert.match(result.evidence, /URL 未变化/);
});

test('动作校验：目标文本缺失判 mismatch', () => {
  const result = verifyActionResult(before, { ...before, fingerprint: 'fp-2' }, { textIncludes: '端侧模型' });
  assert.equal(result.verdict, 'mismatch');
  assert.match(result.evidence, /端侧模型/);
});

test('动作校验：没有契约时诚实返回 unknown', () => {
  const result = verifyActionResult(before, afterOk, undefined);
  assert.equal(result.verdict, 'unknown');
});