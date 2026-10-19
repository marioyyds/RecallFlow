// WebArena 编排器的参数/任务选择逻辑（integrations/webarena/config.mjs）。
//
// 拆出来单测的理由：run.mjs 顶部要动态 import Playwright，若把参数解析写在那里，
// 最该被测的一段（默认值、任务选择、allowRisk 校验）反而因为"环境不满足"跑不到。
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs, validateAllowRisk, loadTasksFromJson, selectTasks } from '../integrations/webarena/config.mjs';

test('parseArgs：默认值合理（allowRisk 不含 destructive/external）', () => {
  const o = parseArgs(['--tasks', 't.json']);
  assert.equal(o.tasks, 't.json');
  assert.deepEqual(o.allowRisk, ['read', 'page', 'write', 'browser', 'network']);
  assert.equal(o.dryRun, false);
  assert.equal(o.pollMs, 3000);
});

test('parseArgs：--task-id 逗号分隔且可重复累积', () => {
  const o = parseArgs(['--tasks', 't.json', '--task-id', '7,44', '--task-id', '108']);
  assert.deepEqual(o.taskIds, [7, 44, 108]);
});

test('parseArgs：未知参数抛错（不静默忽略拼错的 flag）', () => {
  assert.throws(() => parseArgs(['--nope']), /未知参数/);
  assert.throws(() => parseArgs(['--tasks']), /需要一个值/);
});

test('parseArgs：非法数值回落到安全默认值', () => {
  const o = parseArgs(['--limit', 'abc', '--poll-ms', '0', '--timeout-ms', '5']);
  assert.equal(o.limit, 0);
  assert.equal(o.pollMs, 3000);
  assert.equal(o.timeoutMs, 300000);
});

test('validateAllowRisk：high / 未知类别一律拒绝，read 允许（可写可不写）', () => {
  assert.deepEqual(validateAllowRisk(['page', 'write']), ['page', 'write']);
  assert.deepEqual(validateAllowRisk(['read', 'page']), ['read', 'page']);
  assert.throws(() => validateAllowRisk(['high']), /high/);
  assert.throws(() => validateAllowRisk(['everything']), /不可声明类别/);
});

test('loadTasksFromJson：兼容裸数组与 {tasks:[]}', () => {
  assert.deepEqual(loadTasksFromJson('[{"task_id":1}]'), [{ task_id: 1 }]);
  assert.deepEqual(loadTasksFromJson('{"tasks":[{"task_id":2}]}'), [{ task_id: 2 }]);
  assert.throws(() => loadTasksFromJson('{"nope":1}'), /找不到任务数组/);
  assert.throws(() => loadTasksFromJson('not json'), /不是合法 JSON/);
});

test('selectTasks：按 id 过滤并保持原顺序，limit 在过滤之后', () => {
  const tasks = [{ task_id: 1 }, { task_id: 2 }, { task_id: 3 }, { task_id: 4 }];
  assert.deepEqual(selectTasks(tasks, { taskIds: [4, 2] }).map((t) => t.task_id), [2, 4]);
  assert.deepEqual(selectTasks(tasks, { limit: 2 }).map((t) => t.task_id), [1, 2]);
  assert.deepEqual(selectTasks(tasks, { taskIds: [2, 3, 4], limit: 2 }).map((t) => t.task_id), [2, 3]);
});
