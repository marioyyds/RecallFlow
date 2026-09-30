// 「面板 → 后台 → DSH 插件」这一跳的**发送端契约**（扩展侧），以及两条通道的并存约束。
//
// 为什么值得单独钉：这条链路跨两个包，出错时**两端都静默** —— 扩展侧刻意不抛
// （发不出去绝不能影响面板自身），服务端在路径不对时只是 404。
// 而 `sayToDsh` 只依赖 `fetch`、不碰 chrome API（模块顶层也没碰），
// 因此可以在 node 里用 stub fetch 把真实请求（URL / method / headers / body）抓下来比对。
//
// 架构变化（本文件随之重写两次）：
//   旧版把「面板的一个对话回合」POST 到桥接的 /panel-turns（带 token、带 role/pageUrl/at），
//   属于"同步两段对话"；那部分已按删除清单第 4、6 步移除（postPanelTurn 已删除）。
//   现在只做一件事：把**用户自己说的一句话**送进 DSH 的这条会话 —— 插件用
//   agent.send(msg,'next-turn',true) 把它变成真用户消息。
//
// 覆盖不到：Chrome 是否真的把内容脚本的 sendMessage 送到后台（浏览器行为），
//   以及面板 UI 的实际观感（需要真实页面）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { sayToDsh } from '../lib/bridge/relay.js';

const ROOT = path.resolve(import.meta.dirname, '..');

// 「面板 → DSH」只能有**一条发送实现**。
//
// 这条是回归：我为了"先试 DSH、失败回退本地"复制了一份 sendMessage（forwardToDsh），
// 而它没有 rpcId 回填（那份逻辑在 sendPanelTurn 里）。后果很隐蔽 ——
// 消息照样送到、面板照样能用，只是**精确去重永远不生效**（退回按文本猜）。
// 复制实现时最容易丢的就是这类"附带的副作用"。
test('面板只有一条 panel:turn 发送实现（重复实现会绕过 rpcId 回填）', () => {
  const chat = fs.readFileSync(path.join(ROOT, 'lib/page/chat.js'), 'utf8');
  const senders = (chat.match(/type: 'panel:turn'/g) || []).length;
  assert.equal(senders, 1, 'panel:turn 只应有一处发送实现，实际 ' + senders + ' 处');
  assert.ok(!/function forwardToDsh\(/.test(chat), 'forwardToDsh 已删除 —— 它绕过了 rpcId 回填');
  assert.ok(/sendPanelTurn\(turn\)/.test(chat), 'run() 应复用 sendPanelTurn，让 rpcId 落在本地回合对象上');
  // 先记后送：顺序反了就盖不到 rpcId
  const pushAt = chat.indexOf('conversation.push(turn)');
  const sendAt = chat.indexOf('sendPanelTurn(turn)');
  assert.ok(pushAt > 0 && sendAt > pushAt, '必须先 push 本地回合再发送（否则 rpcId 没有落点）');
});

// 页面加载时**不得**把面板缓存的历史重推进 DSH。
//
// 这条是回归：loadConversation 原本会把最近 6 条重推一次，靠"服务端连续去重"兜住 ——
// 而那个去重（recordPanelTurn）在第 4 步随桥接同步部分一起删掉了。
// 后果：每次刷新页面，面板里缓存的旧消息都会以**真实用户消息**身份重新进入会话，
// 还会唤醒空闲会话。这比旧版的"重复显示"严重得多。
test('加载历史时不得重推给 DSH（会话才是真相，面板里的只是缓存）', () => {
  const chat = fs.readFileSync(path.join(ROOT, 'lib/page/chat.js'), 'utf8');
  const loadBody = chat.slice(chat.indexOf('async function loadConversation'), chat.indexOf('async function loadConversation') + 1600);
  assert.ok(loadBody.length > 100, '应能找到 loadConversation 的实现体');
  assert.ok(
    !/recentSpeakTurns\([^)]*\)\)\s*sendPanelTurn/.test(loadBody),
    'loadConversation 不应把载入的历史推给 DSH'
  );
  // 计数器仍要同步，否则下一次增量推送会把老内容当新的发
  assert.ok(/pushedSpeakTurns = countSpeakTurns\(conversation\)/.test(loadBody), '载入后仍要同步计数器');
});

/** 在 stub 生效**期间**执行 fn，并返回它实际发出的请求。 */
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

// ===================== 输入通道（sayToDsh） =====================

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
    () => ({ ok: true, json: async () => ({ ok: true, rpcId: 'recallflow-abc-123', sessionId: 's1' }) }),
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
//
// 注意：断言里**不再包含 postPanelTurn / forwardBridgeEvent** ——
// 它们是"两段对话同步"的产物，已按删除清单第 4、6 步移除。
// 桥接通道本身（连接、长轮询、dispatch）必须保留，那才是 opencode 依赖的部分。
test('两条通道并存：7801（MCP 工具调用，服务 opencode）与 3080（DSH 会话）都在', () => {
  const relay = fs.readFileSync(path.join(ROOT, 'lib/bridge/relay.js'), 'utf8');
  // 桥接那条：连接、长轮询、派发 —— 一个都不能少
  assert.match(relay, /const RELAY_HOST = '127\.0\.0\.1:7801'/, '桥接通道的 host 不能被改掉');
  assert.match(relay, /const RELAY_WS = 'ws:\/\/' \+ RELAY_HOST \+ '\/\?token='/, '桥接 WS 连接必须保留');
  assert.match(relay, /async function httpLoop\(\)/, '桥接长轮询必须保留（WS 断开时的兜底）');
  assert.match(relay, /async function dispatch\(method, params\)/, 'dispatch 必须保留（两条通道共用）');
  // DSH 那条：连接、事件转发、输入
  assert.match(relay, /const DSH_HOST = '127\.0\.0\.1:3080'/, '缺 DSH 通道的 host');
  assert.match(relay, /const DSH_WS = 'ws:\/\/' \+ DSH_HOST \+ '\/recallflow\/ws'/, '缺 DSH 通道的 WS 地址');
  assert.match(relay, /function connectDshWs\(\)/, '缺 DSH 通道的连接函数');
  assert.match(relay, /function forwardSessionEvent\(frame\)/, '缺会话事件转发');
  assert.match(relay, /export async function sayToDsh\(text\)/, '缺 sayToDsh');
  // 已删除的两条旧通道不应复活
  assert.ok(!/export async function postPanelTurn\(/.test(relay), 'postPanelTurn 已删除，不应复活');
  assert.ok(!/function forwardBridgeEvent\(/.test(relay), 'forwardBridgeEvent 已删除，不应复活');
  // 两条连接必须各自独立：DSH 通道不能复用桥接的重连调度（会互相打断）
  assert.match(relay, /function scheduleReconnect\(\)/, '桥接应保留自己的重连调度');
  assert.match(relay, /function scheduleDshReconnect\(\)/, 'DSH 通道应有自己的重连调度');
  const dshBlock = relay.slice(relay.indexOf('function connectDshWs('), relay.indexOf('function handleDshMessage('));
  assert.ok(dshBlock.length > 0, '应能找到 connectDshWs 的实现体');
  assert.ok(!/scheduleReconnect\(\)/.test(dshBlock), 'DSH 通道不应调用桥接的重连函数（会互相打断）');
});
