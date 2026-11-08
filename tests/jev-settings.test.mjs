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
