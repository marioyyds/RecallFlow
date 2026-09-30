// 「面板 → 后台 → 桥接」这一跳的**发送端契约**（扩展侧）。
//
// 为什么值得单独钉：
//   这条链路跨三个包，出错时**两端都静默** —— 扩展侧刻意不抛（反向上报绝不能影响面板
//   自身），服务端在路径不对时只是 404。也就是说改名/改路径后，没有任何一层会报错。
//   而 `postPanelTurn` 只依赖 `fetch`、不碰 chrome API（模块顶层也没碰），
//   因此可以在 node 里用 stub fetch 把真实请求（URL / method / headers / body）抓下来比对。
//
// 覆盖不到的最后一步：Chrome 是否真的把内容脚本的 sendMessage 送到后台 —— 那是浏览器
//   行为，不是本仓库的代码，只能在真实扩展里观测。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { postPanelTurn, sayToDsh } from '../lib/bridge/relay.js';

const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * 在 stub 生效**期间**执行 fn，并返回它实际发出的请求。
 *
 * 注意教训：最初写成「装 stub → import 模块 → finally 立刻还原」——
 * 但 postPanelTurn 是**之后**才调用 fetch 的，那时 stub 已被还原，
 * 于是测试打到了真实网络（还因此"意外验证"了一次旧桥接会返回 404）。
 * fetch 必须在调用期间生效。
 */
async function withStub(impl, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return impl ? impl(url, init) : { ok: true };
  };
  try {
    return { result: await fn(), calls };
  } finally {
    globalThis.fetch = real;
  }
}

test('postPanelTurn: 请求形状与桥接端点逐字一致（URL/method/headers/body）', async () => {
  const { result, calls } = await withStub(null, () =>
    postPanelTurn({ role: 'user', text: '你好', pageUrl: 'u', pageTitle: 't', at: 1 })
  );
  assert.equal(result, true);
  assert.equal(calls.length, 1, '应恰好发一次请求');

  const { url, init } = calls[0];
  // 与 integrations/opencode/recallflow-mcp/index.js 的 `url.pathname === '/panel-turns'` 必须一致
  assert.equal(url, 'http://127.0.0.1:7801/panel-turns', 'URL 与 server 端点不一致（改名后会静默 404）');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(init.headers['X-RecallFlow-Token'], 'recallflow-local-bridge-v1', '缺 token 会被 server 401 拒掉');

  const body = JSON.parse(init.body);
  assert.equal(body.role, 'user');
  assert.equal(body.text, '你好', '中文不能在这里被破坏');
  // server 端读的是这几个字段名，任一改名都会静默落成 undefined
  assert.equal(body.pageUrl, 'u');
  assert.equal(body.pageTitle, 't');
  assert.equal(body.at, 1);
});

test('postPanelTurn: 桥接不可达时返回 false 且不抛 —— 反向上报绝不能影响面板自身', async () => {
  const { result } = await withStub(
    () => {
      throw new Error('ECONNREFUSED');
    },
    () => postPanelTurn({ text: 'x' })
  );
  assert.equal(result, false);
});

test('postPanelTurn: 服务端返回非 2xx 时也返回 false（如实告知，不做过度承诺）', async () => {
  const { result } = await withStub(() => ({ ok: false }), () => postPanelTurn({ text: 'x' }));
  assert.equal(result, false);
});

test('发送端的 URL 路径与 server 的端点路径一致（改名会静默 404，两端都不报错）', async () => {
  const { calls } = await withStub(null, () => postPanelTurn({ text: 'x' }));
  const sentPath = new URL(calls[0].url).pathname; // 发送端真实发出的路径
  const serverSrc = fs.readFileSync(path.join(ROOT, 'integrations/opencode/recallflow-mcp/index.js'), 'utf8');
  assert.ok(
    serverSrc.includes("url.pathname === '" + sentPath + "'"),
    'server 没有实现路径 ' + sentPath + ' —— 改名后这里是唯一能发现的地方'
  );
  // 端口硬编码（扩展读不到环境变量）：MCP server 可用 RECALLFLOW_MCP_PORT 换端口，
  // 扩展侧固定在 7801。所以「桥接必须跑在 7801」是扩展的硬约束 —— 写进断言免得后人困惑。
  const relaySrc = fs.readFileSync(path.join(ROOT, 'lib/bridge/relay.js'), 'utf8');
  assert.match(relaySrc, /RELAY_HOST = '127\.0\.0\.1:7801'/, 'relay 的 host 应仍是硬编码的 127.0.0.1:7801');
  assert.equal(new URL(calls[0].url).host, '127.0.0.1:7801');
});

// ===================== 新架构的输入通道（sayToDsh） =====================

test('sayToDsh: 请求形状与插件端点一致（URL/method/只有 text/不带 token）', async () => {
  const { result, calls } = await withStub(null, () => sayToDsh('你好'));
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:3080/recallflow/say');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.headers['X-RecallFlow-Token'], undefined, '新通道不带 token（插件按来源白名单放行）');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(Object.keys(body), ['text'], '请求体只应有 text');
  assert.equal(body.text, '你好', '中文不能在这里被破坏');
});

test('sayToDsh: 把插件回传的 rpcId 交给调用方（面板靠它精确对齐回声）', async () => {
  const { result } = await withStub(
    () => ({
      ok: true,
      json: async () => ({ ok: true, rpcId: 'recallflow-abc-123', sessionId: 's1' }),
    }),
    () => sayToDsh('你好')
  );
  assert.equal(result.ok, true);
  assert.equal(result.rpcId, 'recallflow-abc-123', 'rpcId 必须原样带回来');
});

test('sayToDsh: body 解析不出来时仍按 HTTP 状态判定成功（只是拿不到 rpcId）', async () => {
  const { result } = await withStub(
    () => ({
      ok: true,
      json: async () => {
        throw new Error('not json');
      },
    }),
    () => sayToDsh('x')
  );
  assert.equal(result.ok, true, 'HTTP 2xx 就该算成功');
  assert.equal(result.rpcId, '', '解析不出 body 时 rpcId 为空，而不是抛错');
});

test('sayToDsh: 空白文本不发请求；不可达/非 2xx 返回 !ok 且不抛', async () => {
  for (const bad of ['', '   ', '\n', null, undefined, 42]) {
    const { result, calls } = await withStub(null, () => sayToDsh(bad));
    assert.equal(result.ok, false, '非法输入应返回 ok:false：' + JSON.stringify(bad));
    assert.equal(calls.length, 0, '非法输入不应发请求：' + JSON.stringify(bad));
  }
  assert.equal(
    await withStub(
      () => {
        throw new Error('ECONNREFUSED');
      },
      () => sayToDsh('x')
    ).then((r) => r.result.ok),
    false
  );
  assert.equal(await withStub(() => ({ ok: false }), () => sayToDsh('x')).then((r) => r.result.ok), false);
});

test('sayToDsh: 发送端路径与插件注册的路径逐字一致（改名会静默 404）', async () => {
  const { calls } = await withStub(null, () => sayToDsh('x'));
  const sentPath = new URL(calls[0].url).pathname;
  const pluginSrc = fs.readFileSync(path.join(ROOT, 'integrations/dsh-plugin-recallflow-one/index.js'), 'utf8');
  assert.ok(pluginSrc.includes("const SAY_PATH = '" + sentPath + "'"), '插件应注册同一个路径：' + sentPath);
  assert.ok(/path:\s*SAY_PATH/.test(pluginSrc), '插件应把 SAY_PATH 用在路由注册上');
});

// ===================== 并存：两条通道都必须存在 =====================
// 这条是**防回归**用的，来自一次真实事故：我曾把扩展的桥接连接"换成"指向 DSH，
// 于是 opencode 的页面工具静默失效（7801 桥接不只服务 DSH）。迁移不等于替换 ——
// 在确认某个组件只有一个消费者之前不要换掉它。
test('两条通道并存：7801（MCP 工具调用，服务 opencode）与 3080（DSH 会话）都在', () => {
  const relay = fs.readFileSync(path.join(ROOT, 'lib/bridge/relay.js'), 'utf8');
  // 桥接那条：连接、长轮询、派发、上报，一个都不能少
  assert.match(relay, /const RELAY_HOST = '127\.0\.0\.1:7801'/, '桥接通道的 host 不能被改掉');
  assert.match(relay, /const RELAY_WS = 'ws:\/\/' \+ RELAY_HOST \+ '\/\?token='/, '桥接 WS 连接必须保留');
  assert.match(relay, /async function httpLoop\(\)/, '桥接长轮询必须保留（WS 断开时的兜底）');
  assert.match(relay, /function forwardBridgeEvent\(ev\)/, '桥接事件转发必须保留（旧插件在并存期仍推事件）');
  assert.match(relay, /export async function postPanelTurn\(turn\)/, 'postPanelTurn 必须保留');
  // DSH 那条：连接、事件转发、输入
  assert.match(relay, /const DSH_HOST = '127\.0\.0\.1:3080'/, '缺 DSH 通道的 host');
  assert.match(relay, /const DSH_WS = 'ws:\/\/' \+ DSH_HOST \+ '\/recallflow\/ws'/, '缺 DSH 通道的 WS 地址');
  assert.match(relay, /function connectDshWs\(\)/, '缺 DSH 通道的连接函数');
  assert.match(relay, /function forwardSessionEvent\(frame\)/, '缺会话事件转发');
  assert.match(relay, /export async function sayToDsh\(text\)/, '缺 sayToDsh');
  // 两条连接必须各自独立：DSH 通道要用自己的重连调度，不能复用桥接那个 ——
  // 复用会导致两条通道互相打断（一条重连把另一条的定时器覆盖掉）。
  assert.match(relay, /function scheduleReconnect\(\)/, '桥接应保留自己的重连调度');
  assert.match(relay, /function scheduleDshReconnect\(\)/, 'DSH 通道应有自己的重连调度');
  const dshBlock = relay.slice(relay.indexOf('function connectDshWs('), relay.indexOf('function handleDshMessage('));
  assert.ok(dshBlock.length > 0, '应能找到 connectDshWs 的实现体');
  assert.ok(
    !/scheduleReconnect\(\)/.test(dshBlock),
    'DSH 通道不应调用桥接的重连函数（会互相打断）—— 它只应用 scheduleDshReconnect()'
  );
});
