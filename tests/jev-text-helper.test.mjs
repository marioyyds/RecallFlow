import test from 'node:test';
import assert from 'node:assert/strict';

import { parseJevFieldText } from '../lib/application/agent/jev-text-helper.ts';

test('JEV 字段文本助手只接受唯一非空 text 字段', () => {
  assert.equal(parseJevFieldText('{"text":"图像编辑"}'), '图像编辑');
  assert.equal(parseJevFieldText('```json\n{"text":"中文内容"}\n```'), '中文内容');

  for (const output of [
    'thinking',
    '{"text":null}',
    '{"text":""}',
    '{"text":"x","extra":true}',
    '{"value":"x"}',
    '{"text":123}',
  ]) {
    assert.throws(() => parseJevFieldText(output), /未输入任何内容/);
  }
});
