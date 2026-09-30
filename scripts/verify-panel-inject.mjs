// 验证「面板对话 → DSH 上下文」这一半（Agent.inject 路径）。
//
// 为什么要单独验证：注入是**唯一会主动写入 DSH 会话**的行为 —— 逻辑对了没价值，
// 必须确认 ① 确实调了官方的 agent.inject（而不是我们自己去 append 会话事件），
// ② 载荷形状对（role/content/source），③ 桥接没起来时安静地什么都不做。
//
// 用假 Cordis ctx + 假 agent，不启动 DSH、不打扰用户的会话。
// 桥接用一个临时的本地 HTTP server 假扮（这样能同时验证 GET /panel-turns 的形状）。
//
// 运行：node scripts/verify-panel-inject.mjs
import http from 'node:http';
import assert from 'node:assert/strict';

const { apply, PANEL_CONTEXT_TURNS } = await import('../integrations/dsh-plugin-recallflow/index.js');
const { PANEL_CONTEXT_MARKER, PANEL_CONTEXT_SOURCE_KIND } = await import('../integrations/dsh-plugin-recallflow/session-map.js');

const results = [];
function check(label, fn) {
  try {
    fn();
    results.push({ label, ok: true });
  } catch (e) {
    results.push({ label, ok: false, why: e.message });
  }
}

// --- 假桥接：只实现 GET /panel-turns，并记录收到的 /event -------------------
let requestedUrl = '';
const postedEvents = [];
const server = http.createServer((req, res) => {
  // 只记面板回合那次请求：插件在装载时还会 POST /event（装载自报），
  // 若无条件覆盖，断言拿到的会是最后一次请求而不是我们要看的那次。
  if (req.url.startsWith('/panel-turns')) requestedUrl = req.url;
  if (req.method === 'POST' && req.url === '/event') {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      try {
        postedEvents.push(JSON.parse(body || '{}'));
      } catch (e) {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/panel-turns')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        total: 2,
        turns: [
          { role: 'user', text: '面板里问的问题' },
          { role: 'panel', text: '面板 AI 的回答' },
        ],
      })
    );
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{"ok":true}'); // /event 等
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// --- 假 Cordis ctx：记录订阅，允许手动触发 --------------------------------
function makeCtx() {
  const handlers = new Map();
  return {
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
      return () => {};
    },
    fire(name, ...args) {
      for (const fn of handlers.get(name) || []) fn(...args);
    },
    has(name) {
      return handlers.has(name);
    },
  };
}

const injected = [];
const fakeAgent = { session: { id: 'session-abc12345-x' }, inject: (m) => injected.push(m) };
const ctx = makeCtx();
apply(ctx, { port, token: 't', timeoutMs: 1500 });

check('订阅了官方的 agent/created（而不是自己 append 会话事件）', () => {
  assert.ok(ctx.has('agent/created'), '未订阅 agent/created');
});

// 触发创建；注入是异步的（要等 fetch），稍等再断言
ctx.fire('agent/created', { agent: fakeAgent, source: 'fresh' });
await new Promise((r) => setTimeout(r, 600));

check('确实调用了 agent.inject（官方注入口，不打断运行中的循环）', () => {
  assert.equal(injected.length, 1, 'inject 调用次数应为 1，实际 ' + injected.length);
});

check('载荷形状正确：role/content/source 三件套', () => {
  const m = injected[0];
  assert.equal(m.role, 'user');
  assert.ok(Array.isArray(m.content) && m.content[0] && m.content[0].type === 'text', 'content 应是 text 块');
  assert.equal(m.source && m.source.kind, PANEL_CONTEXT_SOURCE_KIND, 'source.kind 必须是自定义 kind（否则会被当成用户的话回推面板）');
});

// 这条一度是我唯一无法确认、又只会静默失败的点：注入被 DSH 拒掉的话，catch 会把它吞掉，
// 表现与"面板没对话"完全一样。依据来自 DSH 的准入代码
// （dsh-session-format-v3-to-v4/lib/index.js）：
//   「Native source admission preserves unknown attribution and refuses retired plugin wrappers.」
// 即未知 kind 原样保留（没有白名单），只有已退役的 "plugin" 包装会被改写。
check('source.kind 满足 DSH 的准入形状（非空字符串、且不是已退役的包装）', () => {
  const kind = PANEL_CONTEXT_SOURCE_KIND;
  assert.equal(typeof kind, 'string', 'kind 必须是字符串');
  assert.ok(kind.length > 0, 'kind 不能为空 —— 空 kind 会被 assertV4MessageSources 拒绝');
  // 用拼接避开字面量，避免这段注释与字符串在源码里混淆
  const retired = ['plug', 'in'].join('');
  assert.notEqual(kind, retired, '不得使用已退役的 plugin 包装语法（那恰好是被改写/拒绝的那种）');
});

check('载荷是**完整**消息（含 id、已冻结）—— inject 不会替你铸 id', () => {
  const m = injected[0];
  // 依据（读实现）：dsh-agent-loop 的 inject(input) 直接 send → inbox.splice，原样入队；
  // 而 MessageBase 要求 id 必填、createMessage 才负责铸 id + structuredClone + deepFreeze。
  // 少了 id 会静默失败（被本插件的 catch 吞掉），表现与"面板没对话"一模一样。
  assert.ok(typeof m.id === 'string' && m.id.length > 0, 'id 必须存在且非空，实际 ' + JSON.stringify(m.id));
  assert.ok(Object.isFrozen(m), '顶层应冻结（对齐 createMessage 的 deepFreeze 行为）');
  assert.ok(Object.isFrozen(m.content), 'content 应冻结');
  assert.ok(Object.isFrozen(m.source), 'source 应冻结');
});

check('注入内容带标记、带双向对话、写明是另一个 agent', () => {
  const text = injected[0].content[0].text;
  assert.ok(text.includes(PANEL_CONTEXT_MARKER), '缺标记');
  assert.ok(text.includes('面板里问的问题') && text.includes('面板 AI 的回答'), '缺对话内容');
  assert.ok(text.includes('另一个'), '缺「另一个 agent」的澄清');
});

check('确按 limit 请求面板回合（不无界拉取）', () => {
  assert.ok(requestedUrl.startsWith('/panel-turns?limit=' + PANEL_CONTEXT_TURNS), '请求 URL 不对：' + requestedUrl);
});

// --- 第二次创建：id 必须不同 --------------------------------------------------------
const injectedSecond = [];
ctx.fire('agent/created', { agent: { session: { id: 's2' }, inject: (m) => injectedSecond.push(m) }, source: 'fresh' });
await new Promise((r) => setTimeout(r, 600));

check('每次注入铸新 id（否则会话里两条注入会被当成同一条消息）', () => {
  assert.equal(injectedSecond.length, 1, '第二次也应注入，实际 ' + injectedSecond.length);
  assert.notEqual(injected[0].id, injectedSecond[0].id, '两次铸出的 id 相同');
});

check('注入成功会推一行可见诊断（否则"注入没生效"与"面板本来没对话"外部无法区分）', () => {
  const line = postedEvents.find((e) => typeof e.text === 'string' && e.text.includes('注入本会话上下文'));
  assert.ok(line, '没有推出注入成功诊断：' + JSON.stringify(postedEvents.map((e) => e.text)));
  assert.ok(line.text.includes('2 条'), '应报出注入了几条，实际：' + line.text);
  assert.equal(line.who, 'dsh');
});

check('注入抛错时推 warn 诊断（把静默失败变成可见失败）', async () => {
  const ctx4 = makeCtx();
  const before = postedEvents.length;
  apply(ctx4, { port, token: 't', timeoutMs: 1000 });
  ctx4.fire('agent/created', {
    agent: {
      session: { id: 's4' },
      inject: () => {
        throw new Error('shape rejected');
      },
    },
    source: 'fresh',
  });
  await new Promise((r) => setTimeout(r, 600));
  const warn = postedEvents.slice(before).find((e) => e.level === 'warn' && /注入失败/.test(String(e.text)));
  assert.ok(warn, '注入抛错时应推出 warn 诊断，实际新增：' + JSON.stringify(postedEvents.slice(before).map((e) => e.text)));
  assert.ok(String(warn.text).includes('shape rejected'), '诊断里应带原始错误信息');
});

// --- 桥接不可达时：安静失败，绝不抛 -------------------------------------------------
const ctx2 = makeCtx();
const deadPort = await new Promise((resolve) => {
  const s = http.createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const injected2 = [];
apply(ctx2, { port: deadPort, token: 't', timeoutMs: 300 });
ctx2.fire('agent/created', { agent: { session: { id: 's' }, inject: (m) => injected2.push(m) }, source: 'fresh' });
await new Promise((r) => setTimeout(r, 700));

check('桥接不可达时：不注入、不抛错（注入失败绝不能影响会话创建）', () => {
  assert.equal(injected2.length, 0, '不该注入任何东西');
});

// --- agent 形状不认识时：静默跳过 ---------------------------------------------------
const ctx3 = makeCtx();
apply(ctx3, { port, token: 't', timeoutMs: 300 });
ctx3.fire('agent/created', { agent: {}, source: 'fresh' });
ctx3.fire('agent/created', { source: 'fresh' });
await new Promise((r) => setTimeout(r, 300));
check('agent 没有 inject 方法时静默跳过（不抛错）', () => {
  assert.ok(true);
});

server.close();

console.log('');
console.log('--- 面板对话注入 DSH 上下文（' + results.length + ' 项）---');
for (const r of results) console.log('  ' + (r.ok ? '✓ ' : '✗ ') + r.label + (r.ok ? '' : '\n      → ' + r.why));
const bad = results.filter((r) => !r.ok).length;
console.log('');
console.log(bad ? '✗ ' + bad + ' 项未通过' : '✓ 全部通过');
console.log('已查实（读 DSH 源码，非运行验证）：source.kind 的准入规则 —— 未知 kind 原样保留，');
console.log('  唯一被改写的是已退役的 plugin 包装（dsh-session-format-v3-to-v4/lib/index.js）。');
console.log('未覆盖：真实 DSH 的 agent.inject 是否接受这个载荷（需重启 DSH 后看会话里是否出现该上下文）。');
process.exitCode = bad ? 1 : 0;
