// 最终答复「缺 JSON 终态块」的一次格式补正。
//
// 背景（真实评测）：WebArena 的 23/25 两条，自然语言结论已经正确，但模型最后
// 没有输出任务要求的 ```json 块 —— adapter 只能如实记 UNKNOWN_ERROR。
// 修法必须是「让模型自己把已有结论整理成 JSON」，不是由 harness 把自然语言翻译过去
//（那会伪造成功）。因此这里只测可以确定的行为：
//   · 设置未打开时不补；
//   · 已有 JSON 块时不补；
//   · 只补一次；
//   · 补正提示明确"不重做任务、不新增事实"。
import test from 'node:test';
import assert from 'node:assert/strict';

import { FINAL_JSON_RETRY_PROMPT, hasFinalJsonBlock, shouldRetryFinalJson } from '../lib/assistant/agent.js';
import { webarenaSettings } from '../integrations/webarena/harness.mjs';

test('hasFinalJsonBlock：围栏 JSON 与裸任务对象都算已有', () => {
  assert.equal(hasFinalJsonBlock('结论如下\n```json\n{"task_type":"retrieve"}\n```'), true);
  assert.equal(hasFinalJsonBlock('{"task_type":"retrieve"}'), true);
  assert.equal(hasFinalJsonBlock('{"action":"mutate"}'), true);
});

test('hasFinalJsonBlock：纯自然语言结论不算已有（这正是 23/25 的失败形态）', () => {
  assert.equal(hasFinalJsonBlock('只有 Roxanne Brandon Coffey 和 Nelson 提到打印质量。'), false);
  assert.equal(hasFinalJsonBlock(''), false);
  assert.equal(hasFinalJsonBlock(null), false);
});

test('webarenaSettings：评测默认要求最终 JSON 块', () => {
  assert.equal(webarenaSettings({ apiKey: 'k' }).requireFinalJsonBlock, true);
});

test('shouldRetryFinalJson：只有显式要求且确实缺 JSON 时才补', () => {
  const settings = webarenaSettings({ apiKey: 'k' });
  assert.equal(shouldRetryFinalJson({ settings, content: '纯结论' }), true);
  assert.equal(shouldRetryFinalJson({ settings, content: '结论\n```json\n{}\n```' }), false);
  // complete_task 的总结里有 JSON 也算已有
  assert.equal(shouldRetryFinalJson({ settings, content: '', summary: '{"task_type":"retrieve"}' }), false);
  // 只补一次
  assert.equal(shouldRetryFinalJson({ settings, content: '纯结论', alreadyRetried: true }), false);
  // 没打开设置就不改面板行为
  assert.equal(shouldRetryFinalJson({ settings: {}, content: '纯结论' }), false);
  assert.equal(shouldRetryFinalJson({ content: '纯结论' }), false);
});

test('补正提示：明确不重做任务、不新增事实，并保持原有数据粒度', () => {
  assert.match(FINAL_JSON_RETRY_PROMPT, /不要重新执行任务/);
  assert.match(FINAL_JSON_RETRY_PROMPT, /不要新增任何事实或结论/);
  assert.match(FINAL_JSON_RETRY_PROMPT, /不要包装成对象/);
});
