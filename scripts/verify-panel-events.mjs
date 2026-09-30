// 临时验证：面板事件通道的端到端（隔离端口 7802，不触碰用户的 7801 与扩展）。
// 目标：确认 ①panel_post 真的把话投进队列 ②工具调用真的产生事件
//       ③事件经 /poll 与 MCP 调用两条路都能被扩展取到。
const BASE = 'http://127.0.0.1:7802';
const TOKEN = 'recallflow-local-bridge-v1';
const AUTH = { 'X-RecallFlow-Token': TOKEN };

// 先把队列清空，避免与之前的事件混淆
async function drainPoll() {
  const r = await fetch(BASE + '/poll', { headers: AUTH });
  return r.json();
}

// --- MCP 握手 ---
const MCP_HEADERS = {
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
  const headers = { ...MCP_HEADERS };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await fetch(BASE + '/mcp', { method: 'POST', headers, body: JSON.stringify(body) });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  const text = await res.text();
  const ct = res.headers.get('content-type') || '';
  if (!text) return {};
  if (ct.includes('text/event-stream')) {
    const d = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
    return d.length ? JSON.parse(d[d.length - 1]) : {};
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    return {};
  }
}

const out = [];
const log = (s) => {
  out.push(s);
  console.log(s);
};

await drainPoll(); // 清空历史
await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify-events', version: '1' } });
await rpc('notifications/initialized', {}, true);

// tools/list 应包含 panel_post
const list = await rpc('tools/list', {});
const names = ((list.body && list.body.result && list.body.result.tools) || list.result?.tools || []).map((t) => t.name);
log('tools/list → ' + names.length + ' 个工具；含 panel_post: ' + names.includes('panel_post'));

// ① panel_post
const post = await rpc('tools/call', { name: 'panel_post', arguments: { text: '来自 DSH 的测试留言', level: 'warn' } });
const postRes = ((post.body && post.body.result) || post.result || {}).content || [];
let postPayload = {};
try {
  postPayload = JSON.parse(String((postRes[0] || {}).text || '{}'));
} catch (e) {}
log('panel_post → ' + JSON.stringify(postPayload));
log('  transport=' + postPayload.transport + '（应为 poll-queue：隔离实例没有扩展连着 WS）');

// ② 触发一次真实工具调用（evidence_get 是本地工具，不需要扩展）
await rpc('tools/call', { name: 'evidence_get', arguments: { hash: 'ffffffffffffffff' } });
log('已调用 evidence_get（本地工具，用于产生事件）');

// ③ 取事件
const got = await drainPoll();
const events = got.events || [];
log('');
log('/poll 取到 events: ' + events.length + ' 条');
for (const e of events) {
  log('  ' + JSON.stringify(e));
}

const say = events.find((e) => e.kind === 'say');
const tStart = events.find((e) => e.kind === 'tool' && e.phase === 'start' && e.tool === 'evidence_get');
const tEnd = events.find((e) => e.kind === 'tool' && e.phase === 'end' && e.tool === 'evidence_get');
// 工具的 start/end 里不应出现 panel_post 自己（它不该把自己也播报一遍）
const selfEcho = events.filter((e) => e.kind === 'tool' && e.tool === 'panel_post');

console.log('\n--- 结论 ---');
const checks = [
  ['panel_post 已登记', names.includes('panel_post')],
  ['panel_post 走队列', postPayload.transport === 'poll-queue'],
  ['留言事件成形且 level=warn', Boolean(say) && say.level === 'warn' && say.text.includes('DSH')],
  ['工具调用产生 start 事件', Boolean(tStart)],
  ['工具调用产生 end 事件且 ok', Boolean(tEnd) && tEnd.ok === true],
  ['panel_post 不自我播报', selfEcho.length === 0],
];
for (const [label, ok] of checks) console.log('  ' + (ok ? '✓' : '✗') + ' ' + label);
// 不要在这里立刻 process.exit()：undici 的 socket 还在收尾，
// 强制退出会在 Windows 上撞上 libuv 断言（uv_async.c:94）而变成崩溃退出码 0xC0000409，
// 让「验证通过」看起来像「进程崩了」。改为设 exitCode 让事件循环自然排空。
process.exitCode = checks.every((c) => c[1]) ? 0 : 1;
