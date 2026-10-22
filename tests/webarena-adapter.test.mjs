// WebArena 适配层（lib/eval/webarena-adapter.mjs）的行为测试。
//
// 这一层是"RecallFlow 的自然语言答复"与"WebArena-Verified 要求的结构化终态"之间唯一的翻译。
// 它最容易出的两类错都不报错：契约没写清 → 模型给自由文本 → 解析失败被当成 UNKNOWN_ERROR；
// 解析太宽松 → 把像样的自然语言认成结果 → **假成功**。所以下面两个方向都要钉死。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TASK_TYPES,
  FINAL_STATUS,
  expectedActionOf,
  normalizeTask,
  buildInstruction,
  describeResultsSchema,
  extractFinalJson,
  normalizeAgentResponse,
  validateAgentResponse,
  failureResponse,
  toAgentResponse,
} from '../lib/eval/webarena-adapter.mjs';

const task7 = {
  task_id: 7,
  sites: ['map'],
  start_urls: ['http://localhost:3000/'],
  intent: 'Get the name, state, and zip code of all international airports within 50 km of CMU.',
  eval: [{ evaluator: 'AgentResponseEvaluator', ordered: false, expected: { task_type: 'retrieve', status: 'SUCCESS', retrieved_data: [] } }],
  revision: 1,
};

// ---------------- normalizeTask ----------------

test('normalizeTask：读全必需字段，动作归一化为小写', () => {
  const t = normalizeTask(task7);
  assert.equal(t.taskId, 7);
  assert.deepEqual(t.startUrls, ['http://localhost:3000/']);
  assert.equal(t.expectedAction, 'retrieve');
});

test('normalizeTask：兼容 taskId/startUrls/大写动作等别名', () => {
  const t = normalizeTask({
    taskId: 3,
    startUrls: 'http://x/',
    intent: 'do it',
    eval: [{ expected: { task_type: 'NAVIGATE' } }],
  });
  assert.equal(t.taskId, 3);
  assert.deepEqual(t.startUrls, ['http://x/']);
  assert.equal(t.expectedAction, 'navigate');
});

test('normalizeTask：缺字段一律抛错并点名（不静默跑成 UNKNOWN_ERROR）', () => {
  assert.throws(() => normalizeTask({ intent: 'x', start_urls: ['u'], eval: [{ expected: { task_type: 'retrieve' } }] }), /task_id/);
  assert.throws(() => normalizeTask({ task_id: 1, start_urls: ['u'], eval: [{ expected: { task_type: 'retrieve' } }] }), /intent/);
  assert.throws(() => normalizeTask({ task_id: 1, intent: 'x', eval: [{ expected: { task_type: 'retrieve' } }] }), /start_urls/);
  assert.throws(() => normalizeTask({ task_id: 1, intent: 'x', start_urls: ['u'] }), /期望动作/);
});

test('expectedActionOf：忽略未知动作，返回空串而不是猜一个', () => {
  assert.equal(expectedActionOf({ eval: [{ expected: { task_type: 'delete' } }] }), '');
  assert.equal(expectedActionOf({}), '');
});

// ---------------- buildInstruction ----------------

test('buildInstruction：三要素齐备（任务原文 / 起始页 / 终态契约）', () => {
  const s = buildInstruction(normalizeTask(task7));
  assert.match(s, /international airports within 50 km of CMU/, '必须原样带上 intent');
  assert.match(s, /http:\/\/localhost:3000\//, '必须带起始页');
  assert.match(s, /```json/, '必须要求 JSON 代码块');
  assert.match(s, /"task_type": "retrieve"/, 'retrieve 任务的占位应给出数组形状');
  assert.match(s, /"retrieved_data": \[\]/);
  assert.match(s, /期望：retrieve/, '要告知期望动作');
  for (const code of FINAL_STATUS) assert.ok(s.includes(code), '状态码清单应包含 ' + code);
});

test('buildInstruction：mutate/navigate 的占位用 null（不是空数组）', () => {
  const s = buildInstruction({ intent: 'create issue', startUrls: ['http://g/'], expectedAction: 'mutate' });
  assert.match(s, /"task_type": "mutate"/);
  assert.match(s, /"retrieved_data": null/);
});

test('buildInstruction：检索判据要区分 explicitly / 语义匹配，且姓名照抄', () => {
  const s = buildInstruction(normalizeTask(task7));
  assert.match(s, /explicitly/, '必须告诉模型任务里的 explicitly 是严格条件');
  assert.match(s, /措辞不同/, '没有 explicitly 时要允许同义表述');
  assert.match(s, /照抄页面显示/, '姓名必须照抄（RemyRRemyR 这类不能简写）');
  assert.match(s, /同一个评论者只列一次/, '同一人不能既列显示名又列简写');
});

// ---------------- extractFinalJson ----------------

test('extractFinalJson：取**最后一个**可解析的 JSON 块（模型常先举例再给结论）', () => {
  const text = [
    '先给个示例：',
    '```json',
    '{"task_type":"navigate","status":"SUCCESS","retrieved_data":null}',
    '```',
    '结论：',
    '```json',
    '{"task_type":"retrieve","status":"SUCCESS","retrieved_data":[42]}',
    '```',
  ].join('\n');
  assert.deepEqual(extractFinalJson(text), { task_type: 'retrieve', status: 'SUCCESS', retrieved_data: [42] });
});

test('extractFinalJson：无围栏时回退到平衡花括号对象，且花括号在字符串里不算数', () => {
  const text = '答案是 {"task_type":"retrieve","status":"SUCCESS","retrieved_data":["a}b"]} 完毕';
  assert.deepEqual(extractFinalJson(text), { task_type: 'retrieve', status: 'SUCCESS', retrieved_data: ['a}b'] });
});

test('extractFinalJson：没有结构化块时返回 null（不硬凑）', () => {
  assert.equal(extractFinalJson('这个页面的价格是 899 元。'), null);
  assert.equal(extractFinalJson(''), null);
});

test('extractFinalJson：跳过不是答复对象的 JSON 块', () => {
  const text = ['```json', '{"foo":1}', '```', '```json', '{"action":"navigate","status":"SUCCESS","results":null}', '```'].join('\n');
  assert.equal(extractFinalJson(text).action, 'navigate');
});

// ---------------- normalizeAgentResponse ----------------

test('normalizeAgentResponse：接受 task_type/retrieved_data 与 action/results 两种键名', () => {
  const a = normalizeAgentResponse({ task_type: 'retrieve', status: 'success', retrieved_data: ['x'] });
  assert.deepEqual(a.value, { task_type: 'retrieve', status: 'SUCCESS', retrieved_data: ['x'], error_details: null });
  const b = normalizeAgentResponse({ action: 'navigate', status: 'SUCCESS', results: null });
  assert.equal(b.value.task_type, 'navigate');
  assert.equal(b.value.retrieved_data, null);
});

test('normalizeAgentResponse：读不出动作/状态就报错，不补默认值', () => {
  assert.equal(normalizeAgentResponse({ status: 'SUCCESS' }).ok, false);
  assert.equal(normalizeAgentResponse({ task_type: 'retrieve', status: 'weird' }).ok, false);
  assert.equal(normalizeAgentResponse(null).ok, false);
});

test('normalizeAgentResponse：fallbackAction 只在答案缺动作时兜底', () => {
  const r = normalizeAgentResponse({ status: 'SUCCESS', retrieved_data: [] }, { fallbackAction: 'retrieve' });
  assert.equal(r.ok, true);
  assert.equal(r.value.task_type, 'retrieve');
});

// ---------------- validateAgentResponse ----------------

test('validateAgentResponse：retrieve+SUCCESS 必须有数组；非 retrieve 必须 null/空', () => {
  assert.equal(validateAgentResponse({ task_type: 'retrieve', status: 'SUCCESS', retrieved_data: ['a'] }).ok, true);
  assert.equal(validateAgentResponse({ task_type: 'retrieve', status: 'SUCCESS', retrieved_data: null }).ok, false);
  assert.equal(validateAgentResponse({ task_type: 'mutate', status: 'SUCCESS', retrieved_data: null }).ok, true);
  assert.equal(validateAgentResponse({ task_type: 'navigate', status: 'SUCCESS', retrieved_data: [1] }).ok, false);
});

test('validateAgentResponse：成功不得带 error_details；失败可以不带（官方 expected 常见）', () => {
  const bad1 = validateAgentResponse({ task_type: 'navigate', status: 'SUCCESS', retrieved_data: null, error_details: 'x' });
  assert.equal(bad1.ok, false);
  // 官方 task 183/201/235 的 expected 就是 NOT_FOUND + 无 error_details；不能记成 schema-violation
  const ok2 = validateAgentResponse({ task_type: 'retrieve', status: 'NOT_FOUND_ERROR', retrieved_data: null });
  assert.equal(ok2.ok, true);
  const ok3 = validateAgentResponse({ task_type: 'mutate', status: 'ACTION_NOT_ALLOWED_ERROR', retrieved_data: null });
  assert.equal(ok3.ok, true);
  const good = validateAgentResponse({ task_type: 'retrieve', status: 'NOT_FOUND_ERROR', retrieved_data: null, error_details: 'none' });
  assert.equal(good.ok, true);
});

test('validateAgentResponse：results 必须同类型；对象必须键集合一致', () => {
  assert.equal(validateAgentResponse({ task_type: 'retrieve', status: 'SUCCESS', retrieved_data: [1, 'a'] }).ok, false);
  assert.equal(validateAgentResponse({ task_type: 'retrieve', status: 'SUCCESS', retrieved_data: [{ a: 1 }, { b: 2 }] }).ok, false);
  assert.equal(validateAgentResponse({ task_type: 'retrieve', status: 'SUCCESS', retrieved_data: [{ a: 1 }, { a: 2 }] }).ok, true);
});

// ---------------- toAgentResponse ----------------

test('toAgentResponse：completed + 合法 JSON → 规范化终态', () => {
  const answer = '做完了。\n```json\n{"task_type":"retrieve","status":"SUCCESS","retrieved_data":["Quest"]}\n```';
  const r = toAgentResponse(answer, { state: 'completed', expectedAction: 'retrieve' });
  assert.equal(r.status, 'SUCCESS');
  assert.deepEqual(r.retrieved_data, ['Quest']);
});

test('toAgentResponse：job 非 completed 一律记 UNKNOWN_ERROR，并带上原因', () => {
  for (const state of ['failed', 'stalled', 'cancelled', 'running']) {
    const r = toAgentResponse('随便', { state, error: 'api key 缺失' });
    assert.equal(r.status, 'UNKNOWN_ERROR', state + ' 应为失败');
    assert.match(r.error_details, /api key 缺失/);
  }
});

test('toAgentResponse：没有结构化答复 → UNKNOWN_ERROR（不挽尊成成功）', () => {
  const r = toAgentResponse('这个页面的价格是 899 元。', { state: 'completed' });
  assert.equal(r.status, 'UNKNOWN_ERROR');
  assert.match(r.error_details, /没有可解析/);
});

test('toAgentResponse：抽到但违反 schema → UNKNOWN_ERROR 并写清原因', () => {
  const answer = '```json\n{"task_type":"mutate","status":"SUCCESS","retrieved_data":[1]}\n```';
  const r = toAgentResponse(answer, { state: 'completed' });
  assert.equal(r.status, 'UNKNOWN_ERROR');
  assert.match(r.error_details, /非 retrieve/);
});

test('failureResponse：形状合法（能被 validateAgentResponse 接受）', () => {
  const r = failureResponse('stalled', '无人审批');
  assert.equal(validateAgentResponse(r).ok, true);
});

test('normalizeTask：取与期望动作匹配的 results_schema，不丢字段', () => {
  const t = normalizeTask({
    task_id: 9,
    intent: 'count reviews',
    start_urls: ['__SHOPPING__'],
    sites: ['shopping'],
    eval: [
      { expected: { task_type: 'retrieve' }, results_schema: { type: 'array', items: { type: 'number' } } },
    ],
  });
  assert.deepEqual(t.resultsSchema, { type: 'array', items: { type: 'number' } });
});

test('describeResultsSchema：数字数组 / 对象数组 / null', () => {
  assert.match(describeResultsSchema({ type: 'array', items: { type: 'number' } }), /number 数组/);
  assert.match(
    describeResultsSchema({ type: 'array', items: { type: 'object', properties: { username: {}, post_title: {}, count: {} } } }),
    /username \/ post_title \/ count/
  );
  assert.match(describeResultsSchema({ type: 'null' }), /NOT_FOUND_ERROR/);
});

test('buildInstruction：带 schema / 精确集合 / 聚合规则', () => {
  const t = normalizeTask({
    task_id: 10,
    intent: 'Get the total number of reviews that mention "decent"',
    start_urls: ['__SHOPPING_ADMIN__'],
    sites: ['shopping_admin'],
    eval: [{ expected: { task_type: 'retrieve' }, results_schema: { type: 'array', items: { type: 'number' } } }],
  });
  const s = buildInstruction(t);
  assert.match(s, /number 数组/);
  assert.match(s, /精确集合/);
  assert.match(s, /聚合问题/);
  assert.match(s, /review title/);
  assert.match(s, /报表 \/ 网格/);
  assert.match(s, /top-N/);
  assert.match(s, /ACTION_NOT_ALLOWED_ERROR/);
});

test('buildInstruction：多站点任务必须列出全部 start URL', () => {
  const t = normalizeTask({
    task_id: 671,
    intent: 'post reviews to reddit',
    start_urls: ['http://shop/', 'http://reddit/'],
    sites: ['shopping', 'reddit'],
    eval: [{ expected: { task_type: 'mutate' }, results_schema: { type: 'null' } }],
  });
  const s = buildInstruction(t);
  assert.match(s, /http:\/\/shop\//);
  assert.match(s, /http:\/\/reddit\//);
  assert.match(s, /跨站任务/);
  assert.match(s, /回读目标页/);
});
