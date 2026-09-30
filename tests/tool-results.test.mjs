// tool-results：扩展原始结果 → 给模型看的形状（共享）。
//
// 为什么单独钉：这套加工原本**只在桥接里**做，插件的工具直接返回原始 JSON ——
// 删掉 DSH 的 MCP client 就会静默失去「元素 → 源码文件」。现在两边共用同一份实现，
// 而这里是它的行为契约。
//
// **输入的形状是核对过的，不是编的**（这一点我犯过一次：get_picked_element 那条
// 一开始传的是 {selector, source}，而真实形状是 {found, picked, list} ——
// 测试能过，却什么都没钉住）。核对来源：
//   lib/bridge/relay.js 的 dispatch 与各实现：
//     readActiveTab        → { text }
//     readPageDiagnostics  → { found, tabId, pageUrl, console, network, consoleError, networkError }
//     readVerifyChange     → { found, tabId, pageUrl, targets, console, network, … }
//     getPickedElement     → { found, picked, list }
//   lib/shared/dev-paths.js 的 normalizePickedElement → 只改 picked.source.file 与 list[].source.file
//
// 断言刻意选**稳的**：不依赖路径分隔符或具体拼法，而是断言"能力发生了"
// （能转换时 file 变了、originalFile 保留原值；不能转换时原样返回 + 给出 hint）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyToolResult,
  cursorOverrideFrom,
  normalizeToolResult,
  resolveTargets,
  shapeElementSourceResult,
  shapePageHealthResult,
  shapePickedElementResult,
  shapeTextResult,
  shapeVerifyChangeResult,
  toolCursorKey,
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

test('shapePickedElementResult: 真实形状是 {found, picked, list}（我第一版用了编的形状）', () => {
  assert.deepEqual(shapePickedElementResult(null, CTX), { found: false });

  // **真实形状**，量自两处代码而不是猜：
  //   relay.js 的 getPickedElement → { found:true, picked, list }
  //   dev-paths.js 的 normalizePickedElement → 只改 picked.source.file 与 list[].source.file
  // 我第一版传的是 {selector, source} —— 那条测试能过，但什么都没钉住（真实路径根本没被走到）。
  const real = {
    found: true,
    picked: { selector: '.a', source: { file: DEV_URL, line: 2 } },
    list: [{ selector: '.b', source: { file: DEV_URL, line: 5 } }],
  };
  const r = shapePickedElementResult(real, CTX);
  assert.equal(r.picked.selector, '.a', '选择器原样保留');
  assert.notEqual(r.picked.source.file, DEV_URL, '★ 真实形状下 picked.source.file 必须被改写成磁盘路径');
  assert.equal(r.picked.source.originalFile, DEV_URL, '并保留浏览器侧原值');
  assert.notEqual(r.list[0].source.file, DEV_URL, 'list 里的元素同样要改写');

  // 没有 projectRoot 时不猜测：原样返回
  const noCtx = shapePickedElementResult(real, {});
  assert.equal(noCtx.picked.source.file, DEV_URL);
  assert.equal(noCtx.picked.source.originalFile, undefined);
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

test('applyToolResult: 一站式分派 —— 无状态的直接加工，有状态的用调用方的游标', () => {
  // 无状态：read_console 会被加工（文本重写），其余方法原样返回
  const text = applyToolResult('read_console', { text: 'at ' + DEV_URL }, CTX);
  assert.equal(text.result.ok, true);
  assert.equal(text.cursor, undefined, '无状态方法不该牵扯游标');
  const pass = applyToolResult('browser_read', { text: 'raw' }, CTX);
  assert.deepEqual(pass.result, { text: 'raw' }, '不在清单里的方法原样返回（不做加工）');

  // 有状态：page_health —— 游标通过 onCursor 交回调用方，本模块不私自存
  let saved = null;
  const ph = applyToolResult('page_health', HEALTH_RAW, CTX, {
    cursor: '',
    onCursor: (c) => {
      saved = c;
    },
  });
  assert.equal(ph.result.ok, true);
  assert.ok(ph.cursor, '应返回推进后的游标');
  assert.equal(saved, ph.cursor, '★ 必须通过 onCursor 交回调用方（模块自己不存游标）');

  // 游标没变时不该触发 onCursor（避免无意义的写）
  let called = 0;
  applyToolResult('page_health', HEALTH_RAW, CTX, { cursor: ph.cursor, onCursor: () => { called++; } });
  assert.equal(called, 0, '游标未推进就不该回调');

  // verify_change 也走同一条路
  const vc = applyToolResult(
    'verify_change',
    { found: true, tabId: 1, pageUrl: 'u', pageTitle: 'p', targets: [{ selector: '#a', found: true, text: '好的', visible: true }], console: [], network: [] },
    CTX,
    { targets: [{ selector: '#a', expect: { text: '好的' } }], targetsFromArgs: true }
  );
  assert.equal(vc.result.ok, true);
  assert.equal(vc.result.passed, 1);

  // 未找到标签页：出错结果 + 游标原样带回
  const bad = applyToolResult('page_health', { found: false }, CTX, { cursor: 'keep' });
  assert.equal(bad.result.ok, false);
  assert.equal(bad.cursor, 'keep');
});

test('resolveTargets: 本次调用优先，其次 dev-session；都没有时给出可操作的报错', () => {
  const callArgs = [{ selector: '#a' }];
  const session = { targets: [{ selector: '#b' }] };

  const fromCall = resolveTargets(callArgs, session);
  assert.deepEqual(fromCall.targets, callArgs, '传了就用传的（优先级最高）');
  assert.equal(fromCall.fromArgs, true);
  assert.equal(fromCall.error, null);

  const fromSession = resolveTargets([], session);
  assert.deepEqual(fromSession.targets, session.targets);
  assert.equal(fromSession.fromArgs, false, '来自 dev-session 时要标注，调用方据此写 targetsSource');

  const none = resolveTargets(null, {});
  assert.deepEqual(none.targets, []);
  assert.equal(none.fromArgs, false);
  assert.match(none.error, /没有可验证的目标/, '报错必须直接告诉用户怎么办');
  assert.match(none.error, /dev_session_set/, '……而且要给出具体做法');
  // 空数组等同于"没给"（与桥接原来的判断一致：Array.isArray && length）
  assert.equal(resolveTargets([], {}).error !== null, true);
});

test('toolCursorKey: 按标签页分组（切页不串台）', () => {
  assert.equal(toolCursorKey({ tabId: 7, pageUrl: 'u' }), '7');
  assert.equal(toolCursorKey({ pageUrl: 'u' }), 'u', '没有 tabId 就用 URL');
  assert.equal(toolCursorKey(null), 'default');
  assert.equal(toolCursorKey({}), 'default');
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
