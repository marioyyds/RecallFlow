// 页面轮廓 / 查询分页是控制上下文体积的核心契约：
// 首轮只发导航信息，省略内容必须带 cursor 或明确的继续查询路径。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatSnapshotOutline,
  paginateQueryResults,
  SNAPSHOT_CHAR_BUDGET,
} from '../lib/shared/format/page-results.ts';
import { TOOL_REGISTRY } from '../lib/application/agent/tools.ts';

const tools = new Map(TOOL_REGISTRY.map((tool) => [tool.name, tool.openai]));

test('首轮快照预算收紧到 8000 字符，并由 query / cursor 承担后续读取', () => {
  assert.equal(SNAPSHOT_CHAR_BUDGET, 8000);
});

test('页面轮廓提示列出区域、未分页数量和下一步调用', () => {
  const hint = formatSnapshotOutline({
    outline: {
      regions: [
        { label: '筛选条件', selector: '#filters', interactive: 12, inViewport: 8 },
        { label: '搜索结果', selector: '#results', interactive: 80, inViewport: 6 },
      ],
      omittedRegions: 2,
    },
    counts: { omittedByLimit: 52 },
    nextCursor: 40,
    query: '价格',
  });
  assert.match(hint, /筛选条件/);
  assert.match(hint, /搜索结果/);
  assert.match(hint, /另有 52 个交互元素/);
  assert.match(hint, /get_page_snapshot\(\{cursor:40/);
  assert.match(hint, /inspect_element\(\{op:"query"/);
});

test('查询游标表示已看过多少条，并正确处理末页与越界', () => {
  const first = paginateQueryResults([1, 2, 3, 4, 5], 0, 2);
  assert.deepEqual(first.rows, [1, 2]);
  assert.equal(first.nextCursor, 2);

  const second = paginateQueryResults([1, 2, 3, 4, 5], 4, 2);
  assert.deepEqual(second.rows, [5]);
  assert.equal(second.nextCursor, null);

  const beyond = paginateQueryResults([1, 2], 20, 2);
  assert.deepEqual(beyond.rows, []);
  assert.equal(beyond.nextCursor, null);
});

test('快照与元素查询 schema 暴露 query / cursor / region', () => {
  const snapshot = tools.get('get_page_snapshot');
  const inspect = tools.get('inspect_element');
  assert.ok(snapshot.function.parameters.properties.query);
  assert.ok(snapshot.function.parameters.properties.cursor);
  assert.ok(inspect.function.parameters.properties.region);
  assert.ok(inspect.function.parameters.properties.cursor);
  assert.match(snapshot.function.description, /区域轮廓/);
  assert.match(inspect.function.description, /region 限定与 cursor 分页/);
});
