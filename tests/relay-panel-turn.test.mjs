// 「面板 → 后台 → DSH 插件」这一跳的**发送端契约**（扩展侧）。
//
// 为什么值得单独钉（理由与旧版相同，只是对端从桥接换成了 DSH 插件）：
//   这条链路跨两个包，出错时**两端都静默** —— 扩展侧刻意不抛（反向上报绝不能影响面板
//   自身），服务端在路径不对时只是 404。也就是说改名/改路径后，没有任何一层会报错。
//   而 `sayToDsh` 只依赖 `fetch`、不碰 chrome API（模块顶层也没碰），
//   因此可以在 node 里用 stub fetch 把真实请求（URL / method / headers / body）抓下来比对。
//
// 架构变化（本文件随之重写）：
//   旧版把「面板的一个对话回合」POST 到桥接的 /panel-turns（带 token、带 role/pageUrl/at），
//   属于"同步两段对话"。新版只做一件事：把**用户自己说的一句话**送进 DSH 的这条会话，
//   由插件的 agent.send(msg,'next-turn',true) 变成真用户消息。因此：
//     · 端点变成 DSH 自己的 /recallflow/say（不再需要 token：插件按来源白名单放行）
//     · 请求体只有 text（不再有 role/pageUrl/pageTitle/at —— 那些是"两段对话"的产物）
//
// 覆盖不到：Chrome 是否真的把内容脚本的 sendMessage 送到后台（浏览器行为），
//   以及面板助手不再产生回复这一点（属于面板侧改动，下一轮做）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { sayToDsh } from '../lib/bridge/relay.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const PLUGIN = path.join(ROOT, 'integrations/dsh-plugin-recallflow-one/index.js');

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

test('sayToDsh: 请求形状与插件端点逐字一致（URL/method/headers/body）', async () => {
  const { result, calls } = await withStub(null, () => sayToDsh('你好'));
  assert.equal(result, true);
  assert.equal(calls.length, 1, '应恰好发一次请求');

  const { url, init } = calls[0];
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Type'], 'application/json');
  // 新架构不再有 token：安全性由插件侧的来源白名单承担
  assert.equal(init.headers['X-RecallFlow-Token'], undefined, '不应再带 token');

  const body = JSON.parse(init.body);
  assert.deepEqual(Object.keys(body), ['text'], '请求体只应有 text —— 其余字段是"两段对话"时代的产物');
  assert.equal(body.text, '你好', '中文不能在这里被破坏');
});

test('sayToDsh: 空白文本不发请求（避免把空消息灌进会话）', async () => {
  for (const t of ['', '   ', '\n\t', null, undefined, 42]) {
    const { result, calls } = await withStub(null, () => sayToDsh(t));
    assert.equal(result, false, '非法输入应返回 false：' + JSON.stringify(t));
    assert.equal(calls.length, 0, '非法输入不应发请求：' + JSON.stringify(t));
  }
});

test('sayToDsh: DSH 不可达时返回 false 且不抛 —— 反向上报绝不能影响面板自身', async () => {
  const { result } = await withStub(
    () => {
      throw new Error('ECONNREFUSED');
    },
    () => sayToDsh('x')
  );
  assert.equal(result, false);
});

test('sayToDsh: 服务端返回非 2xx 时也返回 false（如实告知，不做过度承诺）', async () => {
  const { result } = await withStub(() => ({ ok: false }), () => sayToDsh('x'));
  assert.equal(result, false);
});

test('发送端的 URL 路径与插件的端点路径一致（改名会静默 404，两端都不报错）', async () => {
  const { calls } = await withStub(null, () => sayToDsh('x'));
  const sentPath = new URL(calls[0].url).pathname;
  const pluginSrc = fs.readFileSync(PLUGIN, 'utf8');
  // 插件用 SAY_PATH 常量注册路由，因此这里同时检查常量值与该常量的使用
  assert.ok(
    pluginSrc.includes("const SAY_PATH = '" + sentPath + "'"),
    '插件没有定义路径 ' + sentPath + ' —— 改名后这里是唯一能发现的地方'
  );
  assert.ok(/path:\s*SAY_PATH/.test(pluginSrc), '插件应把 SAY_PATH 用在路由注册上');

  // 端口与主机：扩展读不到环境变量，因此这是扩展侧的硬约束，写进断言免得后人困惑。
  const relaySrc = fs.readFileSync(path.join(ROOT, 'lib/bridge/relay.js'), 'utf8');
  assert.match(
    relaySrc,
    /RELAY_HOST = '127\.0\.0\.1:3080'/,
    'relay 的 host 应指向 DSH 自身服务（127.0.0.1:3080）—— 不再是 7801 的桥接'
  );
  assert.equal(new URL(calls[0].url).host, '127.0.0.1:3080');
});

test('relay 的 WS 目标指向插件的 /recallflow/ws（而不是桥接根路径）', () => {
  const relaySrc = fs.readFileSync(path.join(ROOT, 'lib/bridge/relay.js'), 'utf8');
  assert.match(relaySrc, /RELAY_WS = 'ws:\/\/' \+ RELAY_HOST \+ '\/recallflow\/ws'/, 'WS 目标应为插件的 /recallflow/ws');
  const pluginSrc = fs.readFileSync(PLUGIN, 'utf8');
  assert.match(pluginSrc, /const WS_PATH = '\/recallflow\/ws'/, '插件应注册同一个路径');
  assert.ok(/path:\s*WS_PATH/.test(pluginSrc), '插件应把 WS_PATH 用在升级路由注册上');
});
