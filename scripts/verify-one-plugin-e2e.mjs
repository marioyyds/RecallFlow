#!/usr/bin/env node
/**
 * 单插件集成的端到端探针（对着**真实运行中的** DSH 实例跑）。
 *
 * 用法：
 *   node scripts/verify-one-plugin-e2e.mjs [端口]        # 默认 3099
 *
 * 为什么需要它：单元测试（tests/dsh-one-plugin.test.mjs）用假 ctx 验证了插件的处理器逻辑，
 * 但有一类问题只有真实实例能回答 —— 路由**是否在 DSH 的鉴权栅栏内**、SSE 能否真连、
 * CORS 在真实响应里是否生效。这个脚本就是把这些变成可复现的检查。
 *
 * 怎么起被测实例（隔离 profile，不碰用户正在用的那个）：
 *   # 1) 造一个最小 profile（只需 base + web-app 两个 bundle）
 *   ~/.dsh/profiles/rfprobe/package.json   ← {"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]}}}
 *   ~/.dsh/profiles/rfprobe/cordis.patch.yml ← 插入本插件（见仓库 docs/one-session-plugin.md）
 *   # 2) 起它（注意 web 不是子命令，profile 名就是位置参数）
 *   node <dsh>/lib/bin.js --profile rfprobe --port 3099 --no-open
 *
 * 实测结果（2026-09-30，本机）：
 *   GET  /recallflow/stream        200 + text/event-stream + hello 帧        ✓
 *   POST /recallflow/say           到达处理器（无活会话时明确报错，不是 404）  ✓
 *   OPTIONS（chrome-extension://） 204 + Access-Control-Allow-Origin          ✓
 *   OPTIONS（恶意来源）            204 且**无** ACAO（已拒绝）                 ✓
 *   GET  /            /api/plugins 401（对照：这些在栅栏内，我的路由不在）      ✓
 */

const port = Number(process.argv[2] || 3099);
const base = 'http://127.0.0.1:' + port;

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok, detail });
  console.log('  ' + (ok ? '✓ ' : '✗ ') + label + (ok || !detail ? '' : '\n      → ' + detail));
}

async function head(path, init) {
  const res = await fetch(base + path, { ...init, redirect: 'manual' });
  const text = init && init.method === 'GET' && path === '/recallflow/stream' ? '' : await res.text().catch(() => '');
  return { status: res.status, headers: res.headers, text };
}

async function main() {
  console.log('--- 单插件端到端探针（' + base + '）---');

  // 0) 实例是否活着
  try {
    const r = await fetch(base + '/', { redirect: 'manual' });
    // 401 也说明活着（/ 在栅栏内）
    check('实例在监听（/ 返回 ' + r.status + '）', r.status === 401 || r.status === 200);
  } catch (e) {
    check('实例在监听', false, String(e.message));
    console.log('\n✗ 实例没起来，后面的检查都无意义。');
    process.exit(1);
  }

  // 1) SSE 路由可达、且在**栅栏之外**（对比 / 与 /api 的 401）
  const stream = await head('/recallflow/stream', { method: 'GET', headers: { Origin: 'http://127.0.0.1:3080' } });
  check('GET /recallflow/stream 返回 200（未被鉴权栅栏拦下）', stream.status === 200, '实际 ' + stream.status);
  check(
    'SSE 头正确',
    /text\/event-stream/.test(stream.headers.get('content-type') || '') &&
      (stream.headers.get('cache-control') || '').includes('no-cache'),
    'content-type=' + stream.headers.get('content-type') + ' cache-control=' + stream.headers.get('cache-control')
  );
  check(
    '本机来源被放行（ACAO 回显）',
    stream.headers.get('access-control-allow-origin') === 'http://127.0.0.1:3080',
    '实际 ' + stream.headers.get('access-control-allow-origin')
  );

  // 2) hello 帧（读一小段流）
  const hello = await new Promise((resolve) => {
    const ac = new AbortController();
    const timer = setTimeout(() => {
      ac.abort();
      resolve('');
    }, 2500);
    fetch(base + '/recallflow/stream', { signal: ac.signal })
      .then(async (res) => {
        const reader = res.body.getReader();
        const { value } = await reader.read();
        clearTimeout(timer);
        ac.abort();
        resolve(value ? Buffer.from(value).toString('utf8') : '');
      })
      .catch(() => {
        clearTimeout(timer);
        resolve('');
      });
  });
  check('SSE 首帧是 hello（带会话列表）', /"kind":"hello"/.test(hello), JSON.stringify(hello.slice(0, 120)));

  // 3) 输入路由到达处理器（无活会话时应是明确的业务错误，而不是 404/401）
  const say = await head('/recallflow/say', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:3080' },
    body: JSON.stringify({ text: '来自探针的一句话' }),
  });
  check('POST /recallflow/say 到达处理器（不是 404/401）', say.status !== 404 && say.status !== 401, '实际 ' + say.status);
  check(
    '无活会话时给出明确业务错误（而不是静默）',
    say.status === 503 || /没有可用的会话/.test(say.text) || say.status === 200,
    '实际 ' + say.status + ' ' + say.text.slice(0, 100)
  );

  // 4) CORS 预检
  const pre = await head('/recallflow/say', {
    method: 'OPTIONS',
    headers: { Origin: 'chrome-extension://abcdefg', 'Access-Control-Request-Method': 'POST' },
  });
  check('扩展来源的预检被放行', pre.headers.get('access-control-allow-origin') === 'chrome-extension://abcdefg', '实际 ' + pre.headers.get('access-control-allow-origin'));
  check('预检声明了 content-type 与 POST', /content-type/i.test(pre.headers.get('access-control-allow-headers') || '') && /POST/.test(pre.headers.get('access-control-allow-methods') || ''));

  // 5) 恶意来源必须被拒
  const evil = await head('/recallflow/say', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
  check('恶意来源不回 ACAO（已拒绝）', !evil.headers.get('access-control-allow-origin'), '实际 ' + evil.headers.get('access-control-allow-origin'));

  // 6) 对照：栅栏仍在（说明我的路由"在外面"不是因为它被整体关掉了）
  const root = await head('/', { method: 'GET' });
  check('对照：/ 仍在鉴权栅栏内（401）', root.status === 401, '实际 ' + root.status);

  const bad = results.filter((r) => !r.ok).length;
  console.log('');
  console.log(bad ? '✗ ' + bad + ' 项未通过' : '✓ 全部通过（' + results.length + ' 项）');
  process.exit(bad ? 1 : 0);
}

main().catch((e) => {
  console.log('探针异常：' + (e && e.message));
  process.exit(1);
});
