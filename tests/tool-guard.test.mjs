import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolGuard, canonicalize } from '../lib/assistant/tool-guard.js';

const okResult = (extra = {}) => Object.assign({ ok: true, result: 'done' }, extra);
const failResult = (extra = {}) => Object.assign({ ok: false, result: 'boom' }, extra);

test('canonicalize is key-order insensitive', () => {
  assert.equal(canonicalize({ a: 1, b: 2 }), canonicalize({ b: 2, a: 1 }));
  assert.notEqual(canonicalize({ a: 1 }), canonicalize({ a: 2 }));
});

test('repeated identical write call soft-lands with disable at the limit', () => {
  const guard = createToolGuard({ maxSameToolCalls: 3 });
  const call = () => guard.observe({ name: 'click_element', args: { selector: '#a' }, result: okResult(), readOnly: false });
  assert.equal(call().level, 'ok');
  assert.equal(call().level, 'ok');
  assert.equal(call().level, 'reflect');
  assert.equal(call().level, 'disable');
});

test('read-only repeats are tolerated longer than writes', () => {
  const guard = createToolGuard({ maxSameToolCalls: 2, readOnlySameToolCalls: 4 });
  const call = () => guard.observe({ name: 'get_page_snapshot', args: {}, result: okResult(), readOnly: true });
  assert.equal(call().level, 'ok');
  assert.equal(call().level, 'ok');
  assert.equal(call().level, 'reflect');
  assert.equal(call().level, 'reflect');
  assert.equal(call().level, 'disable');
});

test('consecutive failures disable a write tool', () => {
  const guard = createToolGuard({ toolFailStreak: 2 });
  assert.equal(guard.observe({ name: 'edit', args: { i: 1 }, result: failResult(), readOnly: false }).level, 'ok');
  const second = guard.observe({ name: 'edit', args: { i: 2 }, result: failResult(), readOnly: false });
  assert.equal(second.level, 'disable');
  assert.equal(second.reason, 'toolFailStreak');
});

test('read-only failures are also caught (higher threshold)', () => {
  const guard = createToolGuard({ toolFailStreak: 2, readOnlyFailStreak: 3 });
  assert.equal(guard.observe({ name: 'read_console', args: {}, result: failResult(), readOnly: true }).level, 'ok');
  assert.equal(guard.observe({ name: 'read_console', args: {}, result: failResult(), readOnly: true }).level, 'reflect');
  assert.equal(guard.observe({ name: 'read_console', args: {}, result: failResult(), readOnly: true }).level, 'disable');
});

test('validation failure counts as a failure', () => {
  const guard = createToolGuard({ toolFailStreak: 2 });
  assert.equal(guard.observe({ name: 'click_at', args: {}, result: { ok: false, result: 'missing x' }, validationFailed: true }).level, 'ok');
  assert.equal(guard.observe({ name: 'click_at', args: {}, result: { ok: false, result: 'missing x' }, validationFailed: true }).level, 'disable');
});

test('observable progress resets the repeat window', () => {
  const guard = createToolGuard({ maxSameToolCalls: 4, stuckWarnThreshold: 2 });
  const call = (progress = false) => guard.observe({ name: 'scroll_page', args: { to: 'bottom' }, result: okResult(), readOnly: false, progress });
  assert.equal(call().level, 'ok');
  assert.equal(call().level, 'reflect');
  const after = call(true);
  assert.equal(after.repeated, 1);
  assert.equal(after.level, 'ok');
});

test('a rejected call accumulates no-progress but never disables the tool', () => {
  const guard = createToolGuard({ toolFailStreak: 2, stuckStopThreshold: 3, stuckWarnThreshold: 2 });
  const reject = () => guard.observe({ name: 'run_javascript', args: { code: 'x' }, result: { ok: false }, rejected: true, readOnly: false });
  assert.equal(reject().level, 'ok');
  assert.equal(reject().level, 'reflect');
  assert.equal(reject().level, 'stop');
});

test('alternating distinct failing tools still trip the no-progress stop', () => {
  const guard = createToolGuard({ stuckStopThreshold: 3, stuckWarnThreshold: 2, toolFailStreak: 9 });
  assert.equal(guard.observe({ name: 'a', args: {}, result: failResult(), readOnly: false }).level, 'ok');
  assert.equal(guard.observe({ name: 'b', args: {}, result: failResult(), readOnly: false }).level, 'reflect');
  assert.equal(guard.observe({ name: 'c', args: {}, result: failResult(), readOnly: false }).level, 'stop');
});

test('snapshot and restore preserve guard state', () => {
  const guard = createToolGuard({ maxSameToolCalls: 2 });
  guard.observe({ name: 'click_element', args: { s: 1 }, result: okResult(), readOnly: false });
  guard.observe({ name: 'click_element', args: { s: 1 }, result: okResult(), readOnly: false });
  const revived = createToolGuard({ maxSameToolCalls: 2 });
  revived.restore(guard.snapshot());
  const decision = revived.observe({ name: 'click_element', args: { s: 1 }, result: okResult(), readOnly: false });
  assert.equal(decision.level, 'disable');
});
