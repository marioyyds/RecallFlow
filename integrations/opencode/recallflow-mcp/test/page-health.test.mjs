// page-health 单元测试：增量游标、同毫秒边界、去重、定位与安全属性。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  cursorFromEntries,
  parseCursor,
  filterSinceCursor,
  filterSinceTime,
  extractTopFrame,
  summarizePageHealth,
} from '../page-health.js';

const ROOT = path.resolve('proj-root');
const DEV = 'http://localhost:5173';
const CTX = { projectRoot: ROOT, devUrl: DEV };
const disk = (...segs) => path.join(ROOT, ...segs);

const at = (file, line, col) => DEV + '/' + file + ':' + line + (col ? ':' + col : '');
const stackAt = (file, line, col, fn) => 'Error: boom\n    at ' + (fn || 'fn') + ' (' + at(file, line, col) + ')';
const E = (level, text, ts, stack) => ({ level, text, at: ts, stack });

// ---------------------------------------------------------------- 游标

test('cursorFromEntries: 编码最后一条的时间与同毫秒组计数', () => {
  assert.equal(cursorFromEntries([]), '');
  assert.equal(cursorFromEntries([E('log', 'a', 1000)]), '1000.1');
  assert.equal(cursorFromEntries([E('log', 'a', 1000), E('log', 'b', 1000)]), '1000.2');
  assert.equal(cursorFromEntries([E('log', 'a', 1000), E('log', 'b', 2000)]), '2000.1');
});

test('parseCursor: 非法输入与 all 均视为从头读', () => {
  assert.equal(parseCursor(''), null);
  assert.equal(parseCursor('all'), null);
  assert.equal(parseCursor('abc'), null);
  assert.equal(parseCursor(undefined), null);
  assert.deepEqual(parseCursor('1712.3'), { at: 1712, n: 3 });
  assert.deepEqual(parseCursor('1712'), { at: 1712, n: 0 });
});

test('filterSinceCursor: 无游标返回全部', () => {
  const list = [E('log', 'a', 1), E('log', 'b', 2)];
  assert.equal(filterSinceCursor(list, null).length, 2);
});

test('filterSinceCursor: 同一毫秒内按顺序续读，不重不漏（关键用例）', () => {
  const sameMs = [E('error', 'a', 5000), E('error', 'b', 5000), E('error', 'c', 5000)];
  // 已见 2 条（a、b）→ 只应返回 c
  const rest = filterSinceCursor(sameMs, { at: 5000, n: 2 });
  assert.equal(rest.length, 1);
  assert.equal(rest[0].text, 'c');
  // 已见 3 条 → 空
  assert.equal(filterSinceCursor(sameMs, { at: 5000, n: 3 }).length, 0);
  // 已见 0 条 → 全部
  assert.equal(filterSinceCursor(sameMs, { at: 5000, n: 0 }).length, 3);
});

test('filterSinceCursor: 更早的条目不会被重新吐出', () => {
  const list = [E('log', 'old', 100), E('log', 'new', 300)];
  const out = filterSinceCursor(list, { at: 200, n: 0 });
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'new');
});

test('filterSinceTime: 支持 epoch 毫秒与 ISO 串', () => {
  const list = [E('log', 'a', 1000), E('log', 'b', 2000)];
  assert.equal(filterSinceTime(list, 2000).length, 1);
  assert.equal(filterSinceTime(list, 0).length, 2);
  assert.equal(filterSinceTime(list, '').length, 2);
  assert.equal(filterSinceTime(list, new Date(1500).toISOString()).length, 1);
});

// ---------------------------------------------------------------- 定位

test('extractTopFrame: 优先项目自身代码而非 node_modules 帧', () => {
  const stack =
    'Error: boom\n' +
    '    at factory (' + at('node_modules/.vite/deps/react-dom.js', 100, 5) + ')\n' +
    '    at Cart (' + at('src/components/Cart.tsx', 18, 9) + ')';
  const frame = extractTopFrame(stack, CTX);
  assert.equal(frame.location, disk('src', 'components', 'Cart.tsx') + ':18:9');
  assert.equal(frame.frame, 'Cart');
});

test('extractTopFrame: 只有依赖帧时回退到它', () => {
  const stack = 'Error\n    at factory (' + at('node_modules/.vite/deps/react-dom.js', 100, 5) + ')';
  const frame = extractTopFrame(stack, CTX);
  assert.ok(frame.location.includes('react-dom.js'), 'location=' + frame.location);
});

test('extractTopFrame: 无可解析帧时返回 null', () => {
  assert.equal(extractTopFrame('', CTX), null);
  assert.equal(extractTopFrame('Error: boom\n    at <anonymous>', CTX), null);
});

// ---------------------------------------------------------------- 汇总

test('summarizePageHealth: 首次调用返回全部并给出游标', () => {
  const consoleEntries = [
    E('error', 'Cannot read total', 1000, stackAt('src/hooks/useCart.ts', 31, 5, 'useCart')),
    E('log', 'hello', 1000),
    E('warn', 'key warning', 1001, stackAt('src/components/Cart.tsx', 18, 9, 'Cart')),
  ];
  const out = summarizePageHealth({ consoleEntries, projectRoot: ROOT, devUrl: DEV });
  assert.equal(out.cursorUsed, '');
  assert.equal(out.cursor, '1001.1');
  assert.equal(out.errors.length, 1);
  assert.equal(out.errors[0].location, disk('src', 'hooks', 'useCart.ts') + ':31:5');
  assert.equal(out.errors[0].frame, 'useCart');
  assert.equal(out.errors[0].count, 1);
  assert.equal(out.warnings.length, 1);
  // log 不计入（默认只关注 error/warn）
  assert.equal(out.counts.newConsole, 3, '游标推进应基于未过滤集合');
});

test('summarizePageHealth: 用上次游标再读，没有新问题', () => {
  const consoleEntries = [E('error', 'boom', 1000, stackAt('src/A.tsx', 1, 1, 'A'))];
  const first = summarizePageHealth({ consoleEntries, projectRoot: ROOT, devUrl: DEV });
  const second = summarizePageHealth({ consoleEntries, cursor: first.cursor, projectRoot: ROOT, devUrl: DEV });
  assert.equal(second.errors.length, 0);
  assert.equal(second.warnings.length, 0);
  assert.equal(second.counts.newConsole, 0);
  assert.ok(second.summary.includes('没有新的'), 'summary=' + second.summary);
});

test('summarizePageHealth: 增量只返回游标之后的新条目', () => {
  const base = [E('error', 'old', 1000, stackAt('src/A.tsx', 1, 1, 'A'))];
  const first = summarizePageHealth({ consoleEntries: base, projectRoot: ROOT, devUrl: DEV });
  const grown = base.concat([E('error', 'fresh', 2000, stackAt('src/B.tsx', 2, 2, 'B'))]);
  const second = summarizePageHealth({ consoleEntries: grown, cursor: first.cursor, projectRoot: ROOT, devUrl: DEV });
  assert.equal(second.errors.length, 1);
  assert.equal(second.errors[0].message, 'fresh');
  assert.equal(second.errors[0].location, disk('src', 'B.tsx') + ':2:2');
});

test('summarizePageHealth: 同一毫秒追加的记录不会被漏掉（关键用例）', () => {
  const three = [E('error', 'a', 5000), E('error', 'b', 5000), E('error', 'c', 5000)];
  const first = summarizePageHealth({ consoleEntries: three, projectRoot: ROOT, devUrl: DEV });
  assert.equal(first.errors.length, 3);
  assert.equal(first.cursor, '5000.3');
  const four = three.concat([E('error', 'd', 5000)]);
  const second = summarizePageHealth({ consoleEntries: four, cursor: first.cursor, projectRoot: ROOT, devUrl: DEV });
  assert.equal(second.counts.newConsole, 1);
  assert.equal(second.errors.length, 1);
  assert.equal(second.errors[0].message, 'd');
});

test('summarizePageHealth: 重复同类错误聚合成一条并计数', () => {
  const stack = stackAt('src/components/List.tsx', 12, 3, 'List');
  const dup = [E('error', 'same', 2000, stack), E('error', 'same', 2001, stack), E('error', 'same', 2002, stack)];
  const out = summarizePageHealth({ consoleEntries: dup, projectRoot: ROOT, devUrl: DEV });
  assert.equal(out.errors.length, 1);
  assert.equal(out.errors[0].count, 3);
  assert.equal(out.errors[0].firstAt, 2000);
  assert.equal(out.errors[0].lastAt, 2002);
  assert.equal(out.counts.errorGroups, 1);
});

test('summarizePageHealth: 文案或位置不同则不聚合', () => {
  const dup = [
    E('error', 'same', 2000, stackAt('src/A.tsx', 1, 1, 'A')),
    E('error', 'same', 2001, stackAt('src/B.tsx', 2, 2, 'B')),
    E('error', 'other', 2002, stackAt('src/A.tsx', 1, 1, 'A')),
  ];
  const out = summarizePageHealth({ consoleEntries: dup, projectRoot: ROOT, devUrl: DEV });
  assert.equal(out.errors.length, 3);
});

test('summarizePageHealth: levels 可只关注 error', () => {
  const mixed = [E('warn', 'w', 3000), E('error', 'e', 3001)];
  const out = summarizePageHealth({ consoleEntries: mixed, levels: ['error'], projectRoot: ROOT, devUrl: DEV });
  assert.equal(out.warnings.length, 0);
  assert.equal(out.errors.length, 1);
  assert.equal(out.cursor, '3001.1');
});

test('summarizePageHealth: 失败请求（≥400 与网络错误）被聚合，成功请求忽略', () => {
  const networkEntries = [
    { url: DEV + '/api/cart', method: 'GET', status: 500, ok: false, at: 7000, initiator: stackAt('src/api/cart.ts', 12, 3, 'loadCart') },
    { url: DEV + '/api/ok', method: 'GET', status: 200, ok: true, at: 7001 },
    { url: DEV + '/api/down', method: 'POST', status: 0, ok: false, error: 'Failed to fetch', at: 7002 },
  ];
  const out = summarizePageHealth({ networkEntries, projectRoot: ROOT, devUrl: DEV });
  assert.equal(out.failedRequests.length, 2);
  const cart = out.failedRequests.find((f) => f.url.endsWith('/api/cart'));
  assert.equal(cart.status, 500);
  assert.equal(cart.location, disk('src', 'api', 'cart.ts') + ':12:3');
  // 安全属性：接口 URL 本身绝不能被改写成磁盘路径
  assert.equal(cart.url, DEV + '/api/cart');
});

test('summarizePageHealth: fetch 网络失败（无 status/ok，只有 error）也算失败请求', () => {
  // 这是 debug-hook.js 里 fetch 被 reject 时的真实形态：
  // 没有 ok、没有 status，只有 error。漏掉它就会看不见「后端没起来」。
  const networkEntries = [
    { url: DEV + '/api/cart', method: 'GET', error: 'Failed to fetch', ms: 12, at: 8000, initiator: stackAt('src/api/cart.ts', 20, 1, 'loadCart') },
  ];
  const out = summarizePageHealth({ networkEntries, projectRoot: ROOT, devUrl: DEV });
  assert.equal(out.failedRequests.length, 1);
  assert.equal(out.failedRequests[0].status, 0);
  assert.equal(out.failedRequests[0].error, 'Failed to fetch');
  assert.equal(out.failedRequests[0].location, disk('src', 'api', 'cart.ts') + ':20:1');
});

test('summarizePageHealth: summary 反映新增内容', () => {
  const entries = [
    E('error', 'e1', 1000, stackAt('src/A.tsx', 1, 1, 'A')),
    E('error', 'e2', 1001, stackAt('src/A.tsx', 2, 1, 'A')),
    E('warn', 'w1', 1002),
  ];
  const out = summarizePageHealth({ consoleEntries: entries, projectRoot: ROOT, devUrl: DEV });
  assert.ok(out.summary.includes('2 类错误'), 'summary=' + out.summary);
  assert.ok(out.summary.includes('1 类警告'), 'summary=' + out.summary);
});

test('summarizePageHealth: limit 生效且有上限保护', () => {
  const many = [];
  for (let i = 0; i < 5; i++) many.push(E('error', 'e' + i, 1000 + i, stackAt('src/A' + i + '.tsx', 1, 1, 'A')));
  const out = summarizePageHealth({ consoleEntries: many, limit: 2, projectRoot: ROOT, devUrl: DEV });
  assert.equal(out.errors.length, 2);
  const wide = summarizePageHealth({ consoleEntries: many, limit: 9999, projectRoot: ROOT, devUrl: DEV });
  assert.equal(wide.errors.length, 5);
});

test('summarizePageHealth: 空输入安全返回', () => {
  const out = summarizePageHealth();
  assert.equal(out.errors.length, 0);
  assert.equal(out.warnings.length, 0);
  assert.equal(out.failedRequests.length, 0);
  assert.ok(out.summary.includes('没有新的'), 'summary=' + out.summary);
});

test('summarizePageHealth: 无 projectRoot 时仍能列出条目（位置保持 URL）', () => {
  const out = summarizePageHealth({
    consoleEntries: [E('error', 'boom', 1000, stackAt('src/A.tsx', 5, 5, 'A'))],
    devUrl: DEV,
  });
  assert.equal(out.errors.length, 1);
  // 无 projectRoot → toDiskPath 返回服务器根相对路径，不臆造磁盘路径
  assert.equal(out.errors[0].location, '/src/A.tsx:5:5');
});
