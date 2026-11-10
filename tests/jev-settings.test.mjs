import test from 'node:test';
import assert from 'node:assert/strict';

import { webarenaSettings } from '../integrations/webarena/harness.mjs';

test('WebArena settings 可显式注入已启用的 JEV 配置', () => {
  const jev = {
    enabled: true,
    shadowMode: false,
    apiKey: 'jev-test',
    model: 'jev-latest',
    minReadConfidence: 0.72,
  };
  const settings = webarenaSettings({ apiKey: 'chat-test', bridgePort: 7802, jev: JSON.stringify(jev) });
  assert.deepEqual(settings.jev, jev);
  assert.equal(settings.model, 'deepseek-chat');
  assert.equal(settings.bridgePort, 7802);
});

test('未提供 JEV 覆盖时不伪造快思考配置', () => {
  const settings = webarenaSettings({ apiKey: 'chat-test' });
  assert.equal(settings.jev, undefined);
  assert.equal(settings.bridgePort, 7801);
});

test('webarenaSettings：TraceGraph 可用 JSON 覆盖并保持默认关闭', () => {
  assert.equal(webarenaSettings({ apiKey: 'chat-test' }).traceGraph, undefined);
  const live = webarenaSettings({
    apiKey: 'chat-test',
    traceGraph: JSON.stringify({
      enabled: true,
      mode: 'live',
      shadowMode: false,
      ttlMs: 1800000,
    }),
  });
  assert.deepEqual(live.traceGraph, {
    enabled: true,
    mode: 'live',
    shadowMode: false,
    ttlMs: 1800000,
  });
  assert.throws(
    () => webarenaSettings({ apiKey: 'chat-test', traceGraph: '{oops' }),
    /RECALLFLOW_EVAL_TRACEGRAPH_SETTINGS 不是合法 JSON/
  );
});
