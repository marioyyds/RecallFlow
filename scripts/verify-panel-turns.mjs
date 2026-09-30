// 验证「反向通道」的服务端两段（写端 + 读端 + panel_history 工具），
// 用**真实 MCP 协议**调用工具，而不是只做文本层断言。
//
// 为什么需要：反向链路是 面板 → 后台 → 桥接(写) → 环形缓冲 → MCP 工具(读) → DSH 注入。
// 契约测试只能证明"名字对得上"，证明不了"数据真的能进去、能原样出来"。
// 这里在隔离端口 7802 上跑真实 server，把除"扩展那一跳"之外的全部串起来。
//
// 运行：
//   $env:RECALLFLOW_MCP_PORT='7802'; $env:RECALLFLOW_EXT_TIMEOUT_MS='3000'
//   $env:RECALLFLOW_EVIDENCE_DIR="$env:TEMP\rf-evidence-turns"
//   node integrations/opencode/recallflow-mcp/index.js --http   # 后台
//   node scripts/verify-panel-turns.mjs
import assert from 'node:assert/strict';

const PORT = Number(process.env.RECALLFLOW_MCP_PORT || 7802);
const URL_ = 'http://127.0.0.1:' + PORT + '/mcp';
const TOKEN = process.env.RECALLFLOW_BRIDGE_TOKEN || 'recallflow-local-bridge-v1';
const HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  Authorization: 'Bearer ' + TOKEN,
  'X-RecallFlow-Token': TOKEN,
};

let sessionId = null;
async function rpc(method, params, notify) {
  const body = { jsonrpc: '2.0', method };
  if (params !== undefined) body.params = params;
  if (!notify) body.id = Math.floor(Math.random() * 1e9);
  const headers = { ...HEADERS };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await fetch(URL_, { method: 'POST', headers, body: JSON.stringify(body) });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  const text = await res.text();
  if (!text) return { status: res.status, body: null };
  if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
    const datas = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
    return { status: res.status, body: datas.length ? JSON.parse(datas[datas.length - 1]) : null };
  }
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch (e) {
    return { status: res.status, body: null, raw: text.slice(0, 300) };
  }
}

/** 直接打 HTTP 写端（模拟扩展经后台 POST）。 */
async function postTurn(turn) {
  const res = await fetch('http://127.0.0.1:' + PORT + '/panel-turns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-RecallFlow-Token': TOKEN },
    body: JSON.stringify(turn),
  });
  return { status: res.status, body: await res.json() };
}

const results = [];
async function check(label, fn) {
  try {
    await fn();
    results.push({ label, ok: true });
  } catch (e) {
    results.push({ label, ok: false, why: e.message });
  }
}

// --- 写端 -------------------------------------------------------------------
await check('写端：与 /event 用同一套 token 鉴权（无 token 必须被拒）', async () => {
  const res = await fetch('http://127.0.0.1:' + PORT + '/panel-turns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'user', text: 'x' }),
  });
  assert.equal(res.status, 401, '无 token 应为 401，实际 ' + res.status);
});

await check('写端：正常回合落库（ok:true）', async () => {
  const r1 = await postTurn({ role: 'user', text: '面板里用户问的话' });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.ok, true, JSON.stringify(r1.body));
  const r2 = await postTurn({ role: 'panel', text: '面板 AI 的回答' });
  assert.equal(r2.body.ok, true);
});

await check('写端：空文本被拒（ok:false），不污染缓冲', async () => {
  const r = await postTurn({ role: 'user', text: '' });
  assert.equal(r.body.ok, false);
  const r2 = await postTurn({ role: 'user' });
  assert.equal(r2.body.ok, false);
});

// --- 读端（HTTP）-------------------------------------------------------------
await check('读端：GET 能原样读回，且中文无损', async () => {
  const res = await fetch('http://127.0.0.1:' + PORT + '/panel-turns?limit=10', {
    headers: { 'X-RecallFlow-Token': TOKEN },
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  const texts = data.turns.map((t) => t.text);
  assert.ok(texts.includes('面板里用户问的话'), '缺用户回合：' + JSON.stringify(texts));
  assert.ok(texts.includes('面板 AI 的回答'), '缺面板回合');
});

await check('读端：角色被规整为 user/panel（未知取值归 panel）', async () => {
  await postTurn({ role: 'nonsense', text: '未知角色' });
  const data = await (await fetch('http://127.0.0.1:' + PORT + '/panel-turns?limit=5', { headers: { 'X-RecallFlow-Token': TOKEN } })).json();
  const t = data.turns.find((x) => x.text === '未知角色');
  assert.equal(t.role, 'panel', '未知 role 应归一为 panel');
});

// --- /health 的可观测性（这几轮排查里最缺的就是"一眼看出哪一段没动"）-------------
await check('/health 报出事件计数与面板回合数（一次调用看清两个方向）', async () => {
  // 注意 semantics：events 统计的是**正向**通道（POST /event）的事件；
  // panel-turns 走的是反向缓冲，不计入其中。所以这里必须先真的推一条正向事件，
  // 否则断言的前提是错的（我第一版就写错了这一点）。
  await fetch('http://127.0.0.1:' + PORT + '/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-RecallFlow-Token': TOKEN },
    body: JSON.stringify({ text: '健康自检', who: 'dsh' }),
  });
  const h = await (await fetch('http://127.0.0.1:' + PORT + '/health', { headers: { 'X-RecallFlow-Token': TOKEN } })).json();
  assert.ok(h.events && typeof h.events.total === 'number', 'events.total 缺失：' + JSON.stringify(h));
  assert.ok(typeof h.panelTurns === 'number', 'panelTurns 缺失');
  assert.ok(h.events.total >= 1, '推过一条正向事件后 total 应 ≥1，实际 ' + h.events.total);
  assert.equal(h.events.lastKind, 'say/dsh', 'lastKind 应记下最近一条的形状，实际 ' + h.events.lastKind);
  assert.ok(h.events.lastAt > 0, 'lastAt 应被记录');
  assert.ok(h.panelTurns >= 1, '反向缓冲里的回合数应可见，实际 ' + h.panelTurns);
  assert.equal(typeof h.uptimeMs, 'number');
});

// --- 工具端（真实 MCP 协议）---------------------------------------------------
const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify-panel-turns', version: '1.0.0' } });
await rpc('notifications/initialized', undefined, true);

await check('panel_history 已注册进 tools/list（工具名写给模型，拼错就永远调不到）', async () => {
  const r = await rpc('tools/list', {});
  assert.ok(r.body && r.body.result, 'tools/list 无结果：' + JSON.stringify(r).slice(0, 200));
  const names = (r.body.result.tools || []).map((t) => t.name);
  assert.ok(names.includes('panel_history'), '工具清单里没有 panel_history：' + names.join('、'));
});

await check('panel_history 返回面板对话，且带「是另一个 agent」的说明', async () => {
  const r = await rpc('tools/call', { name: 'panel_history', arguments: { limit: 10 } });
  const content = r.body && r.body.result && r.body.result.content;
  assert.ok(Array.isArray(content), 'content 不是数组：' + JSON.stringify(r.body).slice(0, 240));
  const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  assert.ok(text.includes('面板里用户问的话'), '工具返回里没有之前的回合：' + text.slice(0, 200));
  assert.ok(text.includes('另一个') || text.includes('不同的 agent'), '缺「面板 AI 与你不是同一个 agent」的说明：' + text.slice(0, 200));
});

await check('panel_history 的 role 过滤生效', async () => {
  const r = await rpc('tools/call', { name: 'panel_history', arguments: { role: 'panel', limit: 20 } });
  const text = (r.body.result.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  assert.ok(!text.includes('面板里用户问的话'), 'role=panel 不该含用户回合：' + text.slice(0, 200));
  assert.ok(text.includes('面板 AI 的回答'), 'role=panel 应含面板回合');
});

console.log('');
console.log('--- 反向通道服务端两段（' + results.length + ' 项，port ' + PORT + '）---');
for (const r of results) console.log('  ' + (r.ok ? '✓ ' : '✗ ') + r.label + (r.ok ? '' : '\n      → ' + r.why));
const bad = results.filter((r) => !r.ok).length;
console.log('');
console.log(bad ? '✗ ' + bad + ' 项未通过' : '✓ 全部通过');
console.log('未覆盖：扩展那一跳（面板 → 后台 → POST /panel-turns），需重载扩展后由真实面板产生回合。');
process.exitCode = bad ? 1 : 0;
