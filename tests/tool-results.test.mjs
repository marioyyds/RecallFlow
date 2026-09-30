// tool-results：扩展原始结果 → 给模型看的形状（共享）。
//
// 为什么单独钉：这套加工原本**只在桥接里**做，插件的工具直接返回原始 JSON ——
// 删掉 DSH 的 MCP client 就会静默失去「元素 → 源码文件」。现在两边共用同一份实现，
// 而这里是它的行为契约。
//
// 断言刻意选**稳的**：不依赖路径分隔符或具体拼法，而是断言"能力发生了"
// （能转换时 file 变了、originalFile 保留原值；不能转换时原样返回 + 给出 hint）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cursorOverrideFrom,
  normalizeToolResult,
  shapeElementSourceResult,
  shapePageHealthResult,
  shapePickedElementResult,
  shapeTextResult,
  shapeVerifyChangeResult,
} from '../lib/shared/tool-results.js';

const CTX = { projectRoot: 'D:/proj', devUrl: 'http://localhost:5173' };
const DEV_URL = 'http://localhost:5173/src/App.tsx';

test('shapeTextResult: 包成 {ok,text}，并做源码 URL → 磁盘路径的改写', () => {
  const r = shapeTextResult({ text: 'at ' + DEV_URL + ':12:3' }, CTX);
  assert.equal(r.ok, true);
  assert.equal(typeof r.text, 'string');
  assert.ok(!r.text.includes(DEV_URL), '给了 devUrl 就不该再原样保留开发服务器 URL');
  // 没给 ctx（无法转换）时原样返回 —— 绝不能猜
  const raw = shapeTextResult({ text: 'at ' + DEV_URL }, null);
  assert.ok(raw.text.includes(DEV_URL), '依据不足时必须原样返回');
  assert.equal(shapeTextResult(null, CTX).text, '', 'null 输入退化成空文本，不抛');
});

test('shapeElementSourceResult: 三种结局（未找到 / 没有源码信息 / 成形）', () => {
  assert.deepEqual(shapeElementSourceResult(null, CTX), {
    ok: false,
    found: false,
    reason: '未找到元素或框架源码信息（可能不是 React/Vue/Svelte 开发构建）。',
  });
  const given = shapeElementSourceResult({ found: false, reason: '自定义原因' }, CTX);
  assert.equal(given.reason, '自定义原因', '上游给了原因就用上游的');

  // 成形：file 被改写、originalFile 保留原值、text 里带选择器
  const ok = shapeElementSourceResult(
    {
      found: true,
      selector: '.submit',
      source: { file: DEV_URL, line: 3, column: 1, framework: 'react', component: 'Submit' },
    },
    CTX
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.found, true);
  assert.equal(ok.originalFile, DEV_URL, 'originalFile 必须是原值（供对照）');
  assert.notEqual(ok.file, DEV_URL, '★ 能转换时必须真的转换成磁盘路径');
  assert.equal(ok.line, 3);
  assert.equal(ok.component, 'Submit');
  assert.ok(ok.text.includes('元素源码位置：'));
  assert.ok(ok.text.includes('.submit'));
  assert.equal(ok.hint, undefined, '转换成功不该再提示补 dev_session');
});

test('shapeElementSourceResult: 转换不了时原样返回 + 给出 hint', () => {
  const r = shapeElementSourceResult(
    { found: true, selector: 'x', source: { file: DEV_URL, line: 1 } },
    {} // 没有 projectRoot/devUrl
  );
  assert.equal(r.ok, true);
  // 读了 dev-paths 的实现才写这三条：normalizeElementSource 在无法转换时
  // 返回的是**副本原样**（file 保持 URL，且**不设** originalFile）；
  // originalFile 的语义是"转换成功时保留的浏览器侧原值"。
  // 我第一版把 originalFile 当成"转换不了时的原值"，测试红了一次。
  assert.equal(r.file, DEV_URL, '转换不了就原样保留，不猜测');
  // 成形函数里写的是 `originalFile: src.originalFile || ''`（与桥接逐字一致），
  // 所以无法转换时这里是**空串**而不是 undefined —— 我又凭印象断言了一次，红了第二次。
  assert.equal(r.originalFile, '', '无法转换时 originalFile 是空串（成形函数统一补空）');
  assert.ok(r.hint, '★ 这种情况下必须给出"请用 dev_session_set 补上下文"的提示');
});

test('shapePickedElementResult: 走共享的归一化；null 退化成 {found:false}', () => {
  assert.deepEqual(shapePickedElementResult(null, CTX), { found: false });
  const r = shapePickedElementResult({ selector: '.a', source: { file: DEV_URL, line: 2 } }, CTX);
  assert.equal(typeof r, 'object');
  assert.equal(r.selector, '.a', '归一化后仍保留选择器');
});

test('cursorOverrideFrom: 未给 / all / 具体值三态', () => {
  assert.equal(cursorOverrideFrom({}), undefined, '没给就不能当成空串（那是"从头读"的意思）');
  assert.equal(cursorOverrideFrom({ cursor: 'all' }), '', 'all = 从头读');
  assert.equal(cursorOverrideFrom({ cursor: 12345 }), '12345', '数字也归一成字符串');
  assert.equal(cursorOverrideFrom(null), undefined);
});

const HEALTH_RAW = {
  found: true,
  tabId: 7,
  pageUrl: 'http://x/',
  pageTitle: 'T',
  console: [{ level: 'error', text: 'boom', at: 100 }],
  network: [],
};

test('shapePageHealthResult: 无标签页 → 明确错误，且不丢调用方的游标', () => {
  const r = shapePageHealthResult({ found: false }, CTX, { cursor: 'c1' });
  assert.equal(r.result.ok, false);
  assert.match(r.result.error, /未找到活动标签页/);
  assert.equal(r.cursor, 'c1', '失败时不能把调用方的游标清掉');
});

test('shapePageHealthResult: 返回 { result, cursor }，游标交给调用方推进', () => {
  const r = shapePageHealthResult(HEALTH_RAW, CTX, {});
  assert.equal(r.result.ok, true);
  assert.equal(r.result.tabId, 7);
  assert.ok(Array.isArray(r.result.errors), '结果里应带 errors 数组');
  assert.equal(typeof r.cursor, 'string');
  // 游标语义：带上它再查一次，同一批错误应被视为"已消费"
  const again = shapePageHealthResult(HEALTH_RAW, CTX, { cursor: r.cursor });
  assert.equal(again.result.errors.length, 0, '游标已推进 → 同一批不该重复报');
});

test('shapeVerifyChangeResult: 断言求值 + 增量新问题 + targetsSource', () => {
  const targets = [{ selector: '#a', expect: { text: '好的' } }];
  const raw = {
    found: true,
    tabId: 1,
    pageUrl: 'u',
    pageTitle: 'p',
    targets: [{ selector: '#a', found: true, text: '好的', visible: true }],
    console: [],
    network: [],
  };
  const r = shapeVerifyChangeResult(raw, CTX, targets, { targetsFromArgs: true });
  assert.equal(r.result.ok, true);
  assert.equal(r.result.targetsSource, 'call-args');
  assert.equal(r.result.passed, 1);
  assert.equal(r.result.failed, 0);
  assert.ok(r.result.newIssues, '应带增量新问题');
  // targets 来自 dev-session 时标注不同（调用方通过 targetsFromArgs 告知）
  const fromSession = shapeVerifyChangeResult(raw, CTX, targets, { targetsFromArgs: false });
  assert.equal(fromSession.result.targetsSource, 'dev-session');
  // 无标签页：出错但游标保留
  const noTab = shapeVerifyChangeResult({ found: false }, CTX, targets, { cursor: 'k' });
  assert.equal(noTab.result.ok, false);
  assert.match(noTab.result.error, /未找到活动标签页/);
  assert.equal(noTab.cursor, 'k');
});

test('normalizeToolResult: 只认无状态的方法，其余返回 null（交给调用方）', () => {
  assert.ok(normalizeToolResult('read_console', { text: 'x' }, CTX));
  assert.ok(normalizeToolResult('read_network', { text: 'x' }, CTX));
  assert.ok(normalizeToolResult('get_element_source', { found: false }, CTX));
  assert.ok(normalizeToolResult('get_picked_element', { selector: '.a' }, CTX));
  // page_health / verify_change 依赖调用方自己的增量游标 → 不归本模块管
  assert.equal(normalizeToolResult('page_health', {}, CTX), null);
  assert.equal(normalizeToolResult('verify_change', {}, CTX), null);
  assert.equal(normalizeToolResult('browser_read', {}, CTX), null, '不认识的返回 null，不抛');
});
