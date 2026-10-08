// 前缀稳定性门禁的自测：既要证明它在当前代码上通过，也要证明**它在旧写法上会失败**。
// 只测「通过」的门禁毫无意义 —— 一个永远返回 [] 的检查器也能通过。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findPrefixMutations, TARGET } from '../scripts/check-prefix-stability.mjs';

test('前缀稳定性门禁：当前 agent.js 无违规', () => {
  const { findings, scanned } = findPrefixMutations();
  const detail = findings.map((f) => f.line + '  [' + f.rule + ']  ' + f.text).join('\n  ');
  assert.deepEqual(findings, [], '请求前缀可能会被改写：\n  ' + detail);
  assert.ok(scanned > 200, '前置：应扫描到足够多的行，实际 ' + scanned);
});

// 复刻「修复前」的写法：promoteToResearch 改写 messages[0]、syncPlanMessage 每轮 splice、
// 以及守卫摘工具时顺手移动数组。这些在功能上都"正确"，只有前缀缓存会静默失效。
const REGRESSION_FIXTURE = [
  'async function run() {',
  '  let messages = [];',
  '  const injectPlanMessage = () => { messages.splice(1, 0, { role: "system" }); };',
  '  injectPlanMessage();',
  '  for (let iter = resumeIteration; iter < effectiveModelTurns; iter++) {',
  '    messages.splice(1, 0, { role: "system", content: "plan" });',
  '    messages.unshift({ role: "user", content: "x" });',
  '    messages[0] = { role: "system", content: "y" };',
  '    messages.push({ role: "assistant", content: "legit append" });',
  '    injectPlanMessage();',
  '  }',
  '}',
  '',
].join('\n');

test('前缀稳定性门禁：能抓住旧写法（R1 / R2 / R3 / R4 全部命中）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefix-gate-'));
  const file = path.join(dir, 'fixture.js');
  fs.writeFileSync(file, REGRESSION_FIXTURE, 'utf8');
  try {
    const { findings } = findPrefixMutations(file);
    const rules = new Set(findings.map((f) => f.rule));
    for (const rule of ['R1', 'R2', 'R3', 'R4']) {
      assert.ok(rules.has(rule), '规则 ' + rule + ' 未命中；实际命中：' + [...rules].join(','));
    }
    // append 是唯一被允许的写法，不应被误报
    assert.ok(
      !findings.some((f) => f.text.includes('legit append')),
      'messages.push 被误判为违规'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('前缀稳定性门禁：主循环改名后必须报错而不是静默通过', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefix-gate-'));
  const file = path.join(dir, 'fixture.js');
  fs.writeFileSync(file, 'function other() {\n  messages.push(1);\n}\n', 'utf8');
  try {
    const { findings } = findPrefixMutations(file);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].rule, 'R0', '找不到主循环时必须显式失败，否则门禁形同虚设');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('前缀稳定性门禁：目标文件缺失时报错', () => {
  const { findings } = findPrefixMutations(path.join(os.tmpdir(), 'definitely-not-here-' + Date.now() + '.js'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'R0');
});

test('前缀稳定性门禁：TARGET 指向 agent 主循环所在文件', () => {
  assert.ok(fs.existsSync(TARGET), TARGET);
  assert.ok(/agent\.js$/.test(TARGET));
});
