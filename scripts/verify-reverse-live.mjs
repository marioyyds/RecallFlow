// 用**真实运行中的桥接与真实面板数据**验证反向链路的最后一段（只读，不写入）。
//
// 为什么单独有这个脚本：
//   verify-panel-turns.mjs 用的是隔离实例 + 自己塞的假数据，证明的是"服务端实现正确"；
//   而这里读的是用户真实面板产生的回合，并走一遍**插件真正会走的那两个消费端**：
//     ① panel_history 工具（真实 MCP 协议调用，用真实数据）
//     ② buildPanelContextPayload（插件在 agent/created 时构造注入载荷的那个纯函数）
//   这样能给出"如果 DSH 重启，注入与工具读回的**就是这个东西**"的直接证据。
//
// 仍未覆盖：真实 DSH 的 Agent.inject 是否接受该载荷（需要重启 DSH）。
//
// 用法：node scripts/verify-reverse-live.mjs   （默认对着 127.0.0.1:7801）
const PORT = Number(process.env.RECALLFLOW_MCP_PORT || 7801);
const TOKEN = process.env.RECALLFLOW_BRIDGE_TOKEN || 'recallflow-local-bridge-v1';
const HTTP = 'http://127.0.0.1:' + PORT;
const H = { 'X-RecallFlow-Token': TOKEN, 'Content-Type': 'application/json' };

const { buildPanelContextPayload } = await import('../integrations/dsh-plugin-recallflow/session-map.js');

const results = [];
function check(label, fn) {
  try {
    fn();
    results.push({ label, ok: true });
  } catch (e) {
    results.push({ label, ok: false, why: e.message });
  }
}

// --- 1) 读真实数据 ---------------------------------------------------------------
const health = await (await fetch(HTTP + '/health', { headers: H })).json();
const got = await (await fetch(HTTP + '/panel-turns?limit=50', { headers: H })).json();
const turns = got.turns || [];

console.log('桥接: ' + HTTP + '（uptime ' + Math.round((health.uptimeMs || 0) / 1000) + 's）');
console.log('  正向：events.total=' + (health.events.total || 0) + '，最近一条 ' + (health.events.lastKind || '无') +
  '，通道 ' + (health.events.lastTransport || '无') + '，扩展连接=' + health.ws);
console.log('  反向：面板回合 ' + turns.length + ' 条');
for (const t of turns) console.log('    [' + t.role + '] ' + String(t.text).replace(/\s+/g, ' ').slice(0, 70));

check('真实面板回合已到达桥接（扩展那一跳通了）', () => {
  if (!turns.length) throw new Error('panelTurns=0：扩展没在上报（重载扩展了吗？面板里聊过吗？）');
});

check('角色取值在允许集合内（面板侧把非 user 归为 panel）', () => {
  const bad = turns.filter((t) => t.role !== 'user' && t.role !== 'panel');
  if (bad.length) throw new Error('出现未知 role：' + JSON.stringify(bad.map((t) => t.role)));
});

check('中文与内容原样保留（不是被编码/截断过的）', () => {
  const anyCjk = turns.some((t) => /[\u4e00-\u9fa5]/.test(String(t.text)));
  if (turns.length && !anyCjk) throw new Error('没有任何中文 —— 数据可能在传输中被破坏');
});

// --- 2) panel_history 工具（真实 MCP 协议，真实数据）-------------------------------
let sessionId = null;
async function rpc(method, params, notify) {
  const body = { jsonrpc: '2.0', method };
  if (params !== undefined) body.params = params;
  if (!notify) body.id = Math.floor(Math.random() * 1e9);
  const headers = Object.assign({ Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + TOKEN }, H);
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await fetch(HTTP + '/mcp', { method: 'POST', headers, body: JSON.stringify(body) });
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
    return { status: res.status, body: null };
  }
}

await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify-reverse-live', version: '1.0.0' } });
await rpc('notifications/initialized', undefined, true);
const listed = await rpc('tools/list', {});
const toolNames = ((listed.body && listed.body.result && listed.body.result.tools) || []).map((t) => t.name);
const called = toolNames.includes('panel_history')
  ? await rpc('tools/call', { name: 'panel_history', arguments: { limit: 20 } })
  : null;
const toolText = called
  ? ((called.body.result.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'))
  : '';

check('panel_history 已注册（工具名写给模型，拼错就永远调不到）', () => {
  if (!toolNames.includes('panel_history')) throw new Error('工具清单里没有 panel_history：' + toolNames.join('、'));
});

check('panel_history 用真实数据读回了面板对话', () => {
  if (!turns.length) return; // 没数据时不算失败（上面已有专门用例）
  const first = String(turns[0].text).replace(/\s+/g, ' ').slice(0, 20);
  if (!toolText.includes(first)) throw new Error('工具返回里没有面板的第一条回合（找 ' + first + '）');
});

check('工具返回的措辞是「同一个助手、另一个界面」（不再制造两个 AI 的割裂感）', () => {
  if (!toolText) return;
  // 注意：这条断言依赖**正在运行的**服务端代码。若桥接还没重启，
  // 拿到的仍是旧说明（含"不同的 agent"），这时本项会失败 —— 那说明部署没跟上，不是实现错。
  if (/另一个 agent|不同的 agent/.test(toolText)) {
    throw new Error('服务端仍在用旧措辞（两个 agent）—— 桥接需要重启才能加载新文案');
  }
  if (!/同一个助手|同一位助手|另一块屏幕|另一个界面/.test(toolText)) {
    throw new Error('缺少「同一个助手、另一个界面」的说明：' + toolText.slice(0, 160));
  }
});

// --- 3) 插件真正会注入的载荷 -------------------------------------------------------
const payload = buildPanelContextPayload(turns, 'preview-id', { max: 20 });
check('插件构造的注入载荷成形（含 id / role / text 块 / 自定义 source.kind）', () => {
  if (!turns.length) throw new Error('没有面板回合，无法构造载荷（这正是"注入会是空的"那种情况）');
  if (!payload) throw new Error('buildPanelContextPayload 返回 null');
  if (!payload.id) throw new Error('缺 id：inject 不会替你铸 id，会被下游拒（静默）');
  if (payload.role !== 'user') throw new Error('role 应为 user');
  if (!payload.content[0] || payload.content[0].type !== 'text') throw new Error('content 不是 text 块');
  if (payload.source.kind !== 'recallflow-panel') throw new Error('source.kind 不对');
});

if (payload) {
  console.log('');
  console.log('  ── 若现在重启 DSH，新会话将注入的上下文（前 300 字）──');
  console.log('    ' + payload.content[0].text.slice(0, 300).replace(/\n/g, '\n    '));
}

console.log('');
console.log('--- 真实环境反向链路（' + results.length + ' 项）---');
for (const r of results) console.log('  ' + (r.ok ? '✓ ' : '✗ ') + r.label + (r.ok ? '' : '\n      → ' + r.why));
const bad = results.filter((r) => !r.ok).length;
console.log('');
console.log(bad ? '✗ ' + bad + ' 项未通过' : '✓ 全部通过');
console.log('未覆盖：真实 DSH 的 Agent.inject 是否接受该载荷（需重启 DSH 后看会话里是否出现该上下文）。');
process.exitCode = bad ? 1 : 0;
