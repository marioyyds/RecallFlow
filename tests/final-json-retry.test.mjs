// 最终答复「缺 JSON 终态块」的一次格式补正。
//
// 背景（真实评测）：WebArena 的 23/25 两条，自然语言结论已经正确，但模型最后
// 没有输出任务要求的 ```json 块 —— adapter 只能如实记 UNKNOWN_ERROR。
// 修法必须是「让模型自己把已有结论整理成 JSON」，不是由 harness 把自然语言翻译过去
//（那会伪造成功）。因此这条门禁同时钉住三件事：
//   1. 补正只在设置要求时发生；
//   2. 只补一次；
//   3. 补正路径只追加消息 + continue，不构造 JSON。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { hasFinalJsonBlock } from '../lib/assistant/agent.js';
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

test('源码门禁：补正只在 requireFinalJsonBlock 时发生、只补一次、不伪造 JSON', () => {
  const src = fs.readFileSync('lib/assistant/agent.js', 'utf8');
  // 第二条（lastIndexOf）是 final-answer 分支；第一条是 complete_task 分支（见下一条用例）。
  const at = src.lastIndexOf('!finalFormatRetryUsed');
  assert.ok(at > -1, '找不到补正入口（设置没接线）');
  const guard = src.slice(Math.max(0, at - 260), at);
  assert.match(guard, /settings\.requireFinalJsonBlock === true/, '补正必须受设置控制');
  const body = src.slice(at, at + 1100);
  assert.match(body, /!finalFormatRetryUsed/, '必须受"只补一次"保护');
  assert.match(body, /finalFormatRetryUsed = true/, '触发后必须置位');
  assert.match(body, /messages\.push\(\{/, '补正应追加一条用户消息，让模型自己整理');
  assert.match(body, /continue;/, '补正后应继续循环，而不是直接结束');
  assert.ok(!/JSON\.stringify/.test(body), '补正路径不得自己构造 JSON（那是伪造成功）');
});

test('源码门禁：complete_task 收尾路径也必须补正（23/25 就是这条路径）', () => {
  const src = fs.readFileSync('lib/assistant/agent.js', 'utf8');
  const at = src.indexOf("via: 'complete_task'");
  assert.ok(at > -1, 'complete_task 路径没有接补正');
  const around = src.slice(at, at + 700);
  assert.match(around, /FINAL_JSON_RETRY_PROMPT/, '必须复用同一份补正提示');
  assert.match(around, /break;/, '补正后要跳出工具循环、继续外层循环');
  assert.ok(!/JSON\.stringify/.test(around), '不得在补正路径里构造 JSON');
});
