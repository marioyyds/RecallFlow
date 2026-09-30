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

import { postPanelTurn } from '../lib/bridge/relay.js';

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
