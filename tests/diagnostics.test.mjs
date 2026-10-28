// diagnostics.js：read_diagnostics(kind) 的分派与三个 kind 的行为。
//
// 为什么值得单独测：`kind` 由**模型**填。如果分派写错（例如 network 落进 console 分支），
// 模型会拿到另一类数据却以为"没有网络请求" —— 这是静默错误，端到端也未必发现。
// 这里用假的 sendTabMessage / getDownloads 把每条路径都钉住。
import test from 'node:test';
import assert from 'node:assert/strict';

import { readDiagnostics, DIAGNOSTIC_KINDS, readConsole, readNetwork, listDownloads } from '../lib/application/agent/diagnostics.ts';

function mkDeps({ console: c = [], network: n = [], downloads: d = [] } = {}) {
  const calls = [];
  return {
    calls,
    tabId: 7,
    sendTabMessage: async (tabId, msg) => {
      calls.push(msg.type);
      if (msg.type === 'kbGetConsole') return { entries: c };
      if (msg.type === 'kbGetNetwork') return { entries: n };
      throw new Error('未预期的消息类型 ' + msg.type);
    },
    getDownloads: () => d,
  };
}

test('kind 必填：缺失时返回明确错误，而不是猜一个默认类别', async () => {
  // 猜默认会让"想看网络却拿到 console"静默发生 —— 模型只会以为没有网络请求。
  const deps = mkDeps();
  const r = await readDiagnostics(deps, {});
  assert.equal(r.ok, false);
  assert.match(r.result, /需要 kind/);
  assert.match(r.result, /console/, '错误里要列出可用取值');
  assert.deepEqual(deps.calls, [], '不得在 kind 缺失时仍然去读数据');
});

test('kind 非法：报错并列出可用取值', async () => {
  const r = await readDiagnostics(mkDeps(), { kind: 'networkk' });
  assert.equal(r.ok, false);
  assert.match(r.result, /未知的 kind/);
  assert.equal(DIAGNOSTIC_KINDS.join(','), 'console,network,downloads');
});

test('kind=console 走 console 通道（不得串到 network）', async () => {
  const deps = mkDeps({ console: [{ level: 'error', text: 'boom', stack: 'at a.js:1' }] });
  const r = await readDiagnostics(deps, { kind: 'console' });
  assert.equal(r.ok, true);
  assert.deepEqual(deps.calls, ['kbGetConsole'], '必须只请求 console');
  assert.match(r.result, /\[error\] boom/);
  assert.match(r.result, /at a\.js:1/, '堆栈要带出来');
});

test('kind=network 走 network 通道（不得串到 console）', async () => {
  const deps = mkDeps({ network: [{ method: 'POST', status: 500, url: 'https://a.test/api', ms: 12 }] });
  const r = await readDiagnostics(deps, { kind: 'network' });
  assert.equal(r.ok, true);
  assert.deepEqual(deps.calls, ['kbGetNetwork'], '必须只请求 network');
  assert.match(r.result, /POST 500 https:\/\/a\.test\/api \(12ms\)/);
});

test('kind=downloads 走后台下载记录（不请求内容脚本）', async () => {
  const deps = mkDeps({ downloads: [{ suggestedFilename: 'a.zip', url: 'https://a.test/a.zip' }] });
  const r = await readDiagnostics(deps, { kind: 'downloads' });
  assert.equal(r.ok, true);
  assert.deepEqual(deps.calls, [], 'downloads 不该向内容脚本发消息');
  assert.match(r.result, /a\.zip/);
});

test('无标签页时 console / network 返回"无法定位"，而不是抛', async () => {
  const deps = { tabId: null, sendTabMessage: async () => ({}), getDownloads: () => [] };
  for (const kind of ['console', 'network']) {
    const r = await readDiagnostics(deps, { kind });
    assert.equal(r.ok, false, kind + ' 应返回失败');
    assert.match(r.result, /无法定位当前标签页/);
  }
});

test('level / filter / limit 参数分别生效（且不会互相干扰）', async () => {
  const entries = [
    { level: 'error', text: 'e1' },
    { level: 'log', text: 'l1' },
    { level: 'error', text: 'e2' },
  ];
  const onlyError = await readConsole(mkDeps({ console: entries }).sendTabMessage, 7, { level: 'error' });
  assert.match(onlyError.result, /e1/);
  assert.match(onlyError.result, /e2/);
  assert.ok(!/l1/.test(onlyError.result), 'level 过滤应排除 log');

  const net = [
    { method: 'GET', status: 200, url: 'https://a.test/keep' },
    { method: 'GET', status: 200, url: 'https://b.test/drop' },
  ];
  const filtered = await readNetwork(mkDeps({ network: net }).sendTabMessage, 7, { filter: 'a.test' });
  assert.match(filtered.result, /keep/);
  assert.ok(!/drop/.test(filtered.result), 'filter 应按 URL 子串过滤');

  const limited = await readConsole(mkDeps({ console: entries }).sendTabMessage, 7, { limit: 1 });
  assert.match(limited.result, /1 条/, 'limit 应生效');
});

test('limit 被夹在 1..200，越界不得放行', async () => {
  const many = Array.from({ length: 300 }, (_, i) => ({ level: 'log', text: 'x' + i }));
  const r = await readConsole(mkDeps({ console: many }).sendTabMessage, 7, { limit: 9999 });
  assert.match(r.result, /200 条/, 'limit 上限应为 200');
});

test('空结果给出可读提示，而不是空字符串', async () => {
  assert.match((await readDiagnostics(mkDeps(), { kind: 'console' })).result, /暂无 console 记录/);
  assert.match((await readDiagnostics(mkDeps(), { kind: 'network' })).result, /暂无网络请求记录/);
  assert.match(listDownloads(() => [], 7).result, /暂未捕获到下载/);
});
