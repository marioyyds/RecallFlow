// 页面轮廓 / 查询分页是控制上下文体积的核心契约：
// 首轮只发导航信息，省略内容必须带 cursor 或明确的继续查询路径。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatSnapshotResultForModel,
  formatSnapshotOutline,
  paginateQueryResults,
  projectSnapshotForModel,
  queryTerms,
  SNAPSHOT_CHAR_BUDGET,
  selectRelevantTextWindows,
  trimSnapshotElementsToBudget,
} from '../lib/shared/format/page-results.ts';
import { TOOL_REGISTRY } from '../lib/application/agent/tools.ts';
import { shouldSpillToolResult } from '../lib/application/agent/tool-results.ts';

const builtins = new Map(TOOL_REGISTRY.map((tool) => [tool.name, tool]));
const tools = new Map(TOOL_REGISTRY.map((tool) => [tool.name, tool.openai]));

test('首轮快照预算收紧到 8000 字符，并由 query / cursor 承担后续读取', () => {
  assert.equal(SNAPSHOT_CHAR_BUDGET, 8000);
  assert.equal(builtins.get('get_page_snapshot').spillExempt, true, '快照已有自身硬预算，不得再走通用 spill');
});

test('快照不触发通用 spill，普通大结果仍会被暂存', () => {
  const large = 'x'.repeat(6001);
  assert.equal(
    shouldSpillToolResult(builtins.get('get_page_snapshot'), large),
    false,
    '快照的 elements/runtime 不能被通用 3K 前缀截掉'
  );
  assert.equal(
    shouldSpillToolResult(builtins.get('read_current_page'), large),
    true,
    '其它大结果仍要保留 resultStore + expand_result 恢复路径'
  );
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
  assert.deepEqual(
    snapshot.function.parameters.properties.textMode.enum,
    ['auto', 'start', 'relevant', 'none']
  );
  assert.match(snapshot.function.description, /区域轮廓/);
  assert.match(inspect.function.description, /支持 region 与 cursor/);
});

test('queryTerms 会把自然语言拆成可命中标题的词，并补充中文四字窗口', () => {
  const terms = queryTerms('斗破苍穹 最新一集 EP218 视频结果');
  assert.ok(terms.includes('斗破苍穹'));
  assert.ok(terms.includes('ep218'));
  assert.ok(terms.includes('最新一集'));
});

test('relevant 正文只取 query 周围窗口，不再把页面导航当作正文预算', () => {
  const source =
    '首页 Shorts 订阅 推荐 搜索 导航 '.repeat(30) +
    '🔴 斗破苍穹 EP218 官方正片 20分钟 1天前 ' +
    '评论区'.repeat(100);
  const picked = selectRelevantTextWindows(source, '斗破苍穹 EP218', 240, 60);
  assert.match(picked, /EP218/);
  assert.doesNotMatch(picked, /首页 Shorts 订阅 推荐/);
  assert.ok(picked.length <= 240);
});

test('模型快照投影只移除外层元素执行元数据，完整对象不被改写', () => {
  const element = {
    ref: 'rf-1',
    role: 'button',
    label: '提交',
    selector: '#submit',
    rect: { x: 1, y: 2, width: 3, height: 4 },
    center: { x: 2, y: 4 },
    inViewport: true,
  };
  const snapshot = { url: 'https://a.test', elements: [element] };
  const projected = projectSnapshotForModel(snapshot);
  assert.deepEqual(projected.elements[0], {
    ref: 'rf-1',
    role: 'button',
    label: '提交',
    inViewport: true,
  });
  assert.equal(snapshot.elements[0].selector, '#submit', '完整快照不得被就地修改');
  assert.ok(element.rect && element.center);
});

test('模型快照把 elements/runtime 放在 text 前面，优先保留动作信息', () => {
  const projected = projectSnapshotForModel({
    url: 'https://a.test',
    text: '正文',
    elements: [{ ref: 'rf-1' }],
    runtime: { media: [] },
  });
  const json = JSON.stringify(projected);
  assert.ok(json.indexOf('"elements"') < json.indexOf('"text"'));
  assert.ok(json.indexOf('"runtime"') < json.indexOf('"text"'));
});

test('快照最终文本受硬预算限制，超限时先缩正文并说明，不丢掉 elements', () => {
  const result = formatSnapshotResultForModel({
    url: 'https://a.test',
    title: '测试',
    text: '正文'.repeat(5000),
    elements: [{ ref: 'rf-1', label: 'EP218' }],
    runtime: { media: [{ kind: 'video', currentTime: 2 }] },
  }, '快照：\n', '\n提示：继续');
  assert.ok(result.length <= SNAPSHOT_CHAR_BUDGET, '含提示语也不得超过总预算');
  assert.match(result, /"ref":"rf-1"/);
  assert.match(result, /textNotice/);
  assert.match(result, /提示：继续/);
});

test('快照预算按模型投影计算，但返回带完整元数据的原元素', () => {
  const elements = Array.from({ length: 20 }, (_, index) => ({
    ref: 'rf-' + index,
    label: '按钮 ' + index,
    selector: 'section > div:nth-child(' + index + ') > button:nth-of-type(1)'.repeat(4),
    rect: { x: index, y: index, width: 100, height: 30 },
    center: { x: index + 50, y: index + 15 },
  }));
  const trimmed = trimSnapshotElementsToBudget(elements, 0, 900);
  assert.ok(trimmed.elements.length > 1, '投影后应比完整字段版本保留更多元素');
  assert.equal(trimmed.elements[0].selector, elements[0].selector);
  assert.deepEqual(trimmed.elements[0].center, elements[0].center);
});
