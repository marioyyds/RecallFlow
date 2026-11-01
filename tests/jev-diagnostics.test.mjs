import test from 'node:test';
import assert from 'node:assert/strict';

import {
  JEV_DIAGNOSTICS_KEY,
  readJevDiagnostic,
  writeJevDiagnostic,
} from '../lib/application/agent/jev-diagnostics.ts';

function memoryStorage() {
  const values = {};
  return {
    values,
    async get(key) {
      return { [key]: values[key] };
    },
    async set(items) {
      Object.assign(values, items);
    },
  };
}

test('JEV 诊断只保存路由元数据，并可重新读取', async () => {
  const storage = memoryStorage();
  const ok = await writeJevDiagnostic({
    state: 'handoff',
    mode: 'live',
    attempts: 2,
    outcome: 'handoff',
    reason: 'low-expected-progress',
    tool: 'inspect_element',
  }, storage);

  assert.equal(ok, true);
  const saved = storage.values[JEV_DIAGNOSTICS_KEY];
  assert.equal(saved.state, 'handoff');
  assert.equal(saved.reason, 'low-expected-progress');
  assert.ok(saved.updatedAt > 0);
  assert.equal('apiKey' in saved, false, '诊断不得保存 API Key');
  assert.equal('pageText' in saved, false, '诊断不得保存页面正文');

  const loaded = await readJevDiagnostic(storage);
  assert.equal(loaded.state, 'handoff');
  assert.equal(loaded.attempts, 2);
});

test('没有 storage 或 storage 失败时，JEV 诊断安全降级', async () => {
  assert.equal(await writeJevDiagnostic({
    state: 'deciding',
    mode: 'live',
    attempts: 1,
    outcome: 'awaiting-decision',
  }, null), false);
  assert.equal(await readJevDiagnostic(null), null);

  const broken = {
    async get() {
      throw new Error('read failed');
    },
    async set() {
      throw new Error('write failed');
    },
  };
  assert.equal(await writeJevDiagnostic({
    state: 'error',
    mode: 'live',
    attempts: 1,
    outcome: 'error',
  }, broken), false);
  assert.equal(await readJevDiagnostic(broken), null);
});
