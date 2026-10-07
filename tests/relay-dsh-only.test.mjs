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
function installStubs() {
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
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
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
    assert.deepEqual(empty, { ok: false, rpcId: '' }, '空文本应直接返回，不发请求');
    assert.equal(stub.fetchCalls.length, 0, '空文本不该产生任何请求');

    const r = await sayToDsh('你好');
    assert.equal(stub.fetchCalls.length, 1, '应恰好发一次请求');
    const call = stub.fetchCalls[0];
    assert.match(call.url, /^http:\/\/127\.0\.0\.1:3080\/recallflow\/say$/, '应打到 DSH 的 /recallflow/say，实际：' + call.url);
    assert.equal(call.init.method, 'POST');
    assert.equal(JSON.parse(call.init.body).text, '你好');
    assert.deepEqual(r, { ok: true, rpcId: 'test-rpc' }, '应把 rpcId 回传（面板靠它对齐回声）');
  } finally {
    stub.restore();
  }
});
