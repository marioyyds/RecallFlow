#!/usr/bin/env node
/**
 * 单插件集成的端到端探针（对着**真实运行中的** DSH 实例跑）。
 *
 * 用法：
 *   node scripts/verify-one-plugin-e2e.mjs [端口]        # 默认 3099
 *
 * 为什么需要它：单元测试（tests/dsh-one-plugin.test.mjs）用假 ctx 验证处理器逻辑，
 * 但有一类问题只有真实实例能回答 —— 路由**是否在 DSH 的鉴权栅栏内**、
 * **WebSocket 升级在 DSH 里能不能真的建立**（插件是借 DSH 依赖树里的 ws 实现的）、
 * 真实响应里的 CORS 是否生效。这个脚本把这些变成可复现的检查。
 *
 * 怎么起被测实例（隔离 profile，不碰用户正在用的那个）：
 *   1) 造最小 profile：
 *      ~/.dsh/profiles/rfprobe/package.json
 *        {"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]}}}
 *      ~/.dsh/profiles/rfprobe/cordis.patch.yml   ← 插入本插件
 *   2) 起它（注意 web **不是**子命令：`Usage: dsh --profile web [options]` 里的 web 就是 profile 名）
 *      node <dsh>/lib/bin.js --profile rfprobe --port 3099 --no-open
 *
 * 两个反复踩到的坑：
 *   - PowerShell 5.1 的 Set-Content -Encoding UTF8 会写 BOM，profile 的 package.json 会直接解析失败；
 *   - 提交信息/长文本里带引号时不要塞进 shell 命令行。
 */

const port = Number(process.argv[2] || 3099);
const base = 'http://127.0.0.1:' + port;

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok });
  console.log('  ' + (ok ? '✓ ' : '✗ ') + label + (ok || !detail ? '' : '\n      → ' + detail));
}

async function req(path, init) {
  const res = await fetch(base + path, { ...init, redirect: 'manual' });
  const text = await res.text().catch(() => '');
  return { status: res.status, headers: res.headers, text };
}

/** 连一次 WS，收集若干帧后关闭。 */
function wsProbe(path, { timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    const frames = [];
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      try {
        ws.close();
      } catch {}
      resolve({ frames, error: err ? String(err.message || err) : '' });
    };
    let ws;
    try {
      ws = new WebSocket('ws://127.0.0.1:' + port + path);
    } catch (e) {
      resolve({ frames, error: '构造 WebSocket 失败：' + e.message });
      return;
    }
    const timer = setTimeout(() => finish(new Error('超时（未收到足够帧）')), timeoutMs);
    ws.addEventListener('message', (ev) => {
      frames.push(String(ev.data));
      if (frames.length >= 1) {
        clearTimeout(timer);
        setTimeout(() => finish(), 150);
      }
    });
    ws.addEventListener('error', (e) => {
      clearTimeout(timer);
      finish(new Error('WS 错误：' + (e && e.message ? e.message : 'unknown')));
    });
    ws.addEventListener('close', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

async function main() {
  console.log('--- 单插件端到端探针（' + base + '）---');

  try {
    const r = await req('/');
    check('实例在监听（/ 返回 ' + r.status + '）', r.status === 401 || r.status === 200);
  } catch (e) {
    check('实例在监听', false, e.message);
    console.log('\n✗ 实例没起来，后面的检查都无意义。');
    process.exit(1);
  }

  // 1) 输入路由可达（不在栅栏内）
  const say = await req('/say'.replace('/say', '/recallflow/say'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:3080' },
    body: JSON.stringify({ text: '来自探针的一句话' }),
  });
  check('POST /recallflow/say 到达处理器（不是 404/401）', say.status !== 404 && say.status !== 401, '实际 ' + say.status);
  check(
    '无活会话时给出明确业务错误（而不是静默）',
    say.status === 503 || say.status === 200,
    '实际 ' + say.status + ' ' + say.text.slice(0, 120)
  );
  check(
    '本机来源被放行（ACAO 回显）',
    say.headers.get('access-control-allow-origin') === 'http://127.0.0.1:3080',
    '实际 ' + say.headers.get('access-control-allow-origin')
  );

  // 2) 状态路由：把"连没连上、会话找没找到"变成可观测的
  const status = await req('/recallflow/status');
  check('GET /recallflow/status 可用', status.status === 200, '实际 ' + status.status);
  let snap = null;
  try {
    snap = JSON.parse(status.text);
  } catch {}
  check(
    '状态里带 wsReady / clients / sessions（排查时不必靠猜）',
    !!(snap && 'wsReady' in snap && 'clients' in snap && Array.isArray(snap.sessions)),
    status.text.slice(0, 160)
  );

  // 3) CORS 预检
  const pre = await req('/recallflow/say', {
    method: 'OPTIONS',
    headers: { Origin: 'chrome-extension://abcdefg', 'Access-Control-Request-Method': 'POST' },
  });
  check(
    '扩展来源的预检被放行',
    pre.headers.get('access-control-allow-origin') === 'chrome-extension://abcdefg',
    '实际 ' + pre.headers.get('access-control-allow-origin')
  );
  const evil = await req('/recallflow/say', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
  check('恶意来源不回 ACAO（已拒绝）', !evil.headers.get('access-control-allow-origin'));

  // 3) ★ WebSocket：这是本轮的新关键点（插件借 DSH 的 ws 自己实现升级）
  const probe = await wsProbe('/recallflow/ws');
  check('WS 升级成功且收到帧（不是握手失败）', probe.frames.length > 0, 'error=' + probe.error + ' frames=' + probe.frames.length);
  let hello = null;
  try {
    hello = JSON.parse(probe.frames[0] || '{}');
  } catch {}
  check('WS 首帧是 hello（带会话列表）', !!(hello && hello.kind === 'hello'), JSON.stringify(probe.frames[0] || '').slice(0, 140));

  // 4) 对照：栅栏仍在
  const root = await req('/');
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
