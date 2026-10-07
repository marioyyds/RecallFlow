// 新的 relay（只剩 DSH 一条通道）的**行为**验证 —— 用桩，不依赖真实浏览器。
//
// 为什么需要它：`lib/bridge/relay.js` 的改动只有**重载扩展**之后才能在真机上验证，
// 而"重载扩展"是用户的动作。在那之前，至少要把**这半边**钉住：
// 启动函数到底连了哪个地址、会不会还去连 7801、sayToDsh 打到哪条路径。
// 这些都能用假的 WebSocket / fetch / chrome 在 node 里跑出来 —— 比读代码可靠。
//
// 已有的 tests/relay-panel-turn.test.mjs 是**静态**检查（正则读源码）；这条是**执行**它。
import test from 'node:test';
import assert from 'node:assert/strict';

/** 装一套最小桩，返回记录用的事件数组。 */
function installStubs(opts = {}) {
  const events = [];
  const sockets = [];

  class FakeWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSED = 3;
    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.listeners = {};
      sockets.push(this);
      events.push({ kind: 'ws-open-attempt', url });
    }
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    }
    send(data) {
      events.push({ kind: 'ws-send', url: this.url, data });
    }
    close() {
      this.readyState = FakeWebSocket.CLOSED;
    }
  }

  const fetchCalls = [];
  const alarms = [];
  const restore = {
    WebSocket: globalThis.WebSocket,
    fetch: globalThis.fetch,
    chrome: globalThis.chrome,
    setTimeout: globalThis.setTimeout,
  };

  globalThis.WebSocket = FakeWebSocket;
  // `opts.respond` 可以让某条测试改变 /say 的应答（例如模拟插件的 404「找不到指定的会话」）。
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    if (typeof opts.respond === 'function') return opts.respond(url, init);
    return { ok: true, status: 200, json: async () => ({ ok: true, rpcId: 'test-rpc' }), text: async () => '{"ok":true}' };
  };
  globalThis.chrome = {
    alarms: {
      create: (name, opts) => alarms.push({ name, opts }),
      onAlarm: { addListener: () => {} },
    },
    tabs: { query: async () => [], sendMessage: () => {} },
    runtime: { lastError: null },
    storage: { local: { get: async () => ({}) } },
  };
  // 别让重连定时器把测试挂住
  globalThis.setTimeout = (fn, ms) => restore.setTimeout(fn, Math.min(ms, 1));

  return {
    events,
    sockets,
    fetchCalls,
    alarms,
    restore() {
      globalThis.WebSocket = restore.WebSocket;
      globalThis.fetch = restore.fetch;
      globalThis.chrome = restore.chrome;
      globalThis.setTimeout = restore.setTimeout;
    },
  };
}

test('startRecallFlowRelay 只连 DSH(3080)，绝不连 7801', async () => {
  const stub = installStubs();
  try {
    const relay = await import('../lib/bridge/relay.js');
    assert.equal(typeof relay.startRecallFlowRelay, 'function', '应导出 startRecallFlowRelay（旧名 startMcpRelay 已不用）');
    assert.equal(relay.startMcpRelay, undefined, '旧名字不应再存在');

    relay.startRecallFlowRelay();
    await new Promise((r) => setImmediate(r));

    const urls = stub.events.filter((e) => e.kind === 'ws-open-attempt').map((e) => e.url);
    assert.ok(urls.length >= 1, '应该尝试建立 WebSocket 连接，实际一次都没有');
    for (const u of urls) {
      assert.match(u, /^ws:\/\/127\.0\.0\.1:3080\/recallflow\/ws$/, '只应连 DSH 的 3080 通道，实际：' + u);
      assert.ok(!/7801/.test(u), '不得再连 7801 桥接，实际：' + u);
    }
    assert.equal(new Set(urls).size, 1, '只应有一个目标地址，实际：' + urls.join('、'));

    // 心跳/重连用的 alarm 注册仍然要有（自愈机制别删）
    assert.ok(
      stub.alarms.some((a) => a.name === 'recallflow-relay'),
      '应注册 chrome.alarms 的自愈定时器（MV3 service worker 休眠后靠它重启连接）'
    );
  } finally {
    stub.restore();
  }
});

test('sayToDsh 打到 DSH 的 /recallflow/say，空文本不发请求', async () => {
  const stub = installStubs();
  try {
    const { sayToDsh } = await import('../lib/bridge/relay.js');

    const empty = await sayToDsh('   ');
    assert.equal(empty.ok, false, '空文本应直接返回，不发请求');
    assert.equal(stub.fetchCalls.length, 0, '空文本不该产生任何请求');

    const r = await sayToDsh('你好');
    assert.equal(stub.fetchCalls.length, 1, '应恰好发一次请求');
    const call = stub.fetchCalls[0];
    assert.match(call.url, /^http:\/\/127\.0\.0\.1:3080\/recallflow\/say$/, '应打到 DSH 的 /recallflow/say，实际：' + call.url);
    assert.equal(call.init.method, 'POST');
    const sent = JSON.parse(call.init.body);
    assert.equal(sent.text, '你好');
    assert.equal('sessionId' in sent, false, '不指定会话时**不该**带 sessionId（默认行为必须与以前一模一样）');
    assert.deepEqual(r, { ok: true, rpcId: 'test-rpc', error: '' }, '应把 rpcId 回传（面板靠它对齐回声）');

    // 指定会话：必须真的带上去（面板"选会话"就靠这个字段）
    const r2 = await sayToDsh('给 B 的话', 'session-B');
    assert.equal(stub.fetchCalls.length, 2);
    const sent2 = JSON.parse(stub.fetchCalls[1].init.body);
    assert.equal(sent2.sessionId, 'session-B', '指定了会话就必须带上，否则面板的选择无效');
    assert.equal(sent2.text, '给 B 的话');
    assert.ok(r2.ok);

    // 空字符串/纯空格 = 没指定（不要把 '' 当成一条会话）
    await sayToDsh('再说一句', '   ');
    const sent3 = JSON.parse(stub.fetchCalls[2].init.body);
    assert.equal('sessionId' in sent3, false, '空白 sessionId 应视作未指定');

    // elements（2026-10-08）：面板拾取的元素随消息一起送给 AI。
    const els = [{ tag: 'button', selector: '.x', source: 'a.tsx:1' }];
    await sayToDsh('看这个元素', '', els);
    const sent4 = JSON.parse(stub.fetchCalls[3].init.body);
    assert.deepEqual(sent4.elements, els, 'elements 必须真的进请求体（插件靠它拼摘要）');
    assert.equal(sent4.text, '看这个元素');

    // **空数组 / 不传** → 请求体里完全不出现 elements（不拾取时与改动前一模一样）
    await sayToDsh('没有元素', '', []);
    const sent5 = JSON.parse(stub.fetchCalls[4].init.body);
    assert.equal('elements' in sent5, false, '空数组不该带 elements（默认路径必须不变）');
    await sayToDsh('也没传', '');
    const sent6 = JSON.parse(stub.fetchCalls[5].init.body);
    assert.equal('elements' in sent6, false, '不传时更不该有 elements');
  } finally {
    stub.restore();
  }
});

test('sayToDsh：插件报"找不到指定的会话"时，把原因原样带回来', async () => {
  const stub = installStubs({
    // 让 /say 返回 404 + 插件的错误说明
    respond: async () => ({
      ok: false,
      status: 404,
      json: async () => ({ ok: false, error: '找不到指定的会话：session-x（当前已知会话：session-A）' }),
      text: async () => '',
    }),
  });
  try {
    const { sayToDsh } = await import('../lib/bridge/relay.js');
    const r = await sayToDsh('这条发不出去', 'session-x');
    assert.equal(r.ok, false, '404 时 ok 必须是 false');
    assert.match(r.error, /找不到指定的会话/, '必须把插件的原因带回来 —— 否则面板只能显示"没反应"');
  } finally {
    stub.restore();
  }
});
