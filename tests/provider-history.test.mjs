import test from 'node:test';
import assert from 'node:assert/strict';

import {
  modelRequiresReasoningReplay,
  prepareProviderMessages,
} from '../lib/application/agent/provider-history.ts';

test('仅 DeepSeek thinking 模型在携带 tools 时回传 reasoning_content', () => {
  assert.equal(modelRequiresReasoningReplay({ model: 'deepseek-flash' }), true);
  assert.equal(modelRequiresReasoningReplay({ model: 'deepseek-reasoner' }), true);
  assert.equal(modelRequiresReasoningReplay({ model: 'deepseek-v4-pro' }), true);
  assert.equal(modelRequiresReasoningReplay({ model: 'deepseek-chat' }), false);
  assert.equal(modelRequiresReasoningReplay({ model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' }), true);
  assert.equal(modelRequiresReasoningReplay({ model: 'gpt-compatible' }), false);
});

test('供应商消息保留真实 reasoning，合成工具轮补空值，并剥离 UI lane', () => {
  const messages = [
    { role: 'system', content: 's', lane: 'slow' },
    {
      role: 'assistant',
      content: '',
      lane: 'fast',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_page_snapshot', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: '页面' },
    { role: 'assistant', content: '继续', reasoning_content: '真实思维' },
  ];
  const prepared = prepareProviderMessages(messages, { model: 'deepseek-flash' }, true);
  assert.equal('lane' in prepared[0], false);
  assert.equal('lane' in prepared[1], false);
  assert.equal(prepared[1].reasoning_content, '', '合成的工具调用轮也必须带字段');
  assert.equal(prepared[3].reasoning_content, '真实思维');
});

test('不携带 tools 或非 thinking 模型时不注入不兼容字段', () => {
  const messages = [{ role: 'assistant', content: '', tool_calls: [] }];
  assert.equal(
    'reasoning_content' in prepareProviderMessages(messages, { model: 'deepseek-flash' }, false)[0],
    false
  );
  assert.equal(
    'reasoning_content' in prepareProviderMessages(messages, { model: 'gpt-compatible' }, true)[0],
    false
  );
});
