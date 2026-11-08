import test from 'node:test';
import assert from 'node:assert/strict';

import {
  modelRequiresReasoningReplay,
  normalizeProviderMessages,
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

test('严格 provider：所有 system 合并为唯一头部消息，非 system 顺序不变', () => {
  const base = { role: 'system', content: '基础规则' };
  const user = { role: 'user', content: '用户请求' };
  const task = { role: 'system', content: '任务策略' };
  const assistant = { role: 'assistant', content: '下一步' };
  const plan = { role: 'system', content: '当前计划' };
  const messages = [base, user, task, assistant, plan];

  const normalized = normalizeProviderMessages(messages);
  assert.deepEqual(normalized.map((message) => message.role), ['system', 'user', 'assistant']);
  assert.equal(normalized[0].content, '基础规则\n\n任务策略\n\n当前计划');
  assert.equal(normalized[1], user, '非 system 消息必须保持原对象与顺序');
  assert.equal(normalized[2], assistant);
  assert.equal(messages.length, 5, '规范化不得修改内部历史');
  assert.equal(messages[2], task, '内部 system 也不得被搬走或改写');
});

test('严格 provider：system 位于历史中间时也移到开头，且不破坏工具配对顺序', () => {
  const messages = [
    { role: 'system', content: '基础' },
    { role: 'user', content: '打开页面' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'open_tab', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    { role: 'system', content: '研究画像' },
    { role: 'user', content: '继续' },
  ];
  const normalized = normalizeProviderMessages(messages);
  assert.deepEqual(normalized.map((message) => message.role), [
    'system',
    'user',
    'assistant',
    'tool',
    'user',
  ]);
  assert.equal(normalized[0].content, '基础\n\n研究画像');
  assert.equal(normalized.filter((message) => message.role === 'system').length, 1);
  assert.equal(normalized[2].tool_calls[0].id, 'c1');
  assert.equal(normalized[3].tool_call_id, 'c1');
});

test('严格 provider：多段 system content 被展开而不是变成 [object Object]', () => {
  const normalized = normalizeProviderMessages([
    {
      role: 'system',
      content: [
        { type: 'text', text: '第一段' },
        { type: 'text', text: '第二段' },
      ],
    },
    { role: 'user', content: '执行' },
  ]);
  assert.equal(normalized[0].content, '第一段\n\n第二段');
});
