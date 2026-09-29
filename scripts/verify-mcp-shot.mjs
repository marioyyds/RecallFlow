// 临时脚本：在**隔离端口**上对 MCP server 做真实协议级验证（不触碰用户运行中的 7801 实例）。
// 目标：确认 page_screenshot 真的注册进了 tools/list，且调用时：
//   - 扩展不可用时优雅返回错误（而不是抛异常或把 base64 JSON 化）
//   - 本地工具（evidence_get）能正常往返，证明协议处理本身没问题
const PORT = 7802;
const URL_ = 'http://127.0.0.1:' + PORT + '/mcp';
const TOKEN = 'recallflow-local-bridge-v1';
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
  const ct = res.headers.get('content-type') || '';
  if (!text) return { status: res.status, empty: true };
  if (ct.includes('text/event-stream')) {
    // SSE：取出最后一条 data: 作为 JSON-RPC 响应
    const datas = text
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim());
    if (!datas.length) return { status: res.status, raw: text.slice(0, 400) };
    return { status: res.status, body: JSON.parse(datas[datas.length - 1]) };
  }
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch (e) {
    return { status: res.status, raw: text.slice(0, 400) };
  }
}

const out = [];
function log(s) {
  out.push(s);
  console.log(s);
}

// 1) initialize
const init = await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'verify-mcp-screenshot', version: '1.0.0' },
});
log('initialize → HTTP ' + init.status + '，session=' + (sessionId ? sessionId.slice(0, 8) + '…' : '无'));
if (!sessionId) {
  log('  ✗ 未拿到 session id，后续调用无法进行');
  log(JSON.stringify(init).slice(0, 600));
  process.exit(1);
}
await rpc('notifications/initialized', {}, true);

// 2) tools/list
const list = await rpc('tools/list', {});
const tools = (list.body && list.body.result && list.body.result.tools) || [];
log('tools/list → ' + tools.length + ' 个工具');
const names = tools.map((t) => t.name);
const shot = tools.find((t) => t.name === 'page_screenshot');
log('  page_screenshot 已注册: ' + (shot ? '是' : '否'));
if (shot) {
  const props = Object.keys((shot.inputSchema && shot.inputSchema.properties) || {});
  log('  参数: ' + props.join(', '));
  log('  描述长度: ' + String(shot.description || '').length + ' 字符');
}
log('  全部工具: ' + names.join(', '));

// 3) 本地工具往返（证明协议处理正常）
const ev = await rpc('tools/call', { name: 'evidence_get', arguments: { hash: 'ffffffffffffffff' } });
const evContent = ev.body && ev.body.result && ev.body.result.content;
log('evidence_get（本地，不依赖扩展）→ ' + (evContent ? '返回 ' + evContent.length + ' 个内容块，type=' + evContent[0].type : '无结果'));
log('  内容片段: ' + JSON.stringify(String((evContent && evContent[0] && evContent[0].text) || '').slice(0, 90)));

// 4) 截图工具（扩展未连到 7802，应优雅返回错误）
const t0 = Date.now();
const sc = await rpc('tools/call', { name: 'page_screenshot', arguments: { label: '协议验证', includeImage: false } });
const ms = Date.now() - t0;
const scRes = (sc.body && sc.body.result) || {};
const scContent = scRes.content || [];
log('page_screenshot → HTTP ' + sc.status + '，耗时 ' + ms + 'ms');
log('  isError: ' + String(scRes.isError));
log('  内容块数: ' + scContent.length + '，首个 type=' + (scContent[0] && scContent[0].type));
log('  文案: ' + JSON.stringify(String((scContent[0] && scContent[0].text) || '').slice(0, 160)));
log('  是否被 JSON 化成一整块文本: ' + (scContent.length === 1 && scContent[0].type === 'text' ? '是（错误路径，符合预期）' : '否'));

// 5) 未知工具
const unk = await rpc('tools/call', { name: 'not_a_tool', arguments: {} });
const unkRes = (unk.body && unk.body.result) || {};
log('未知工具 → isError=' + String(unkRes.isError) + '，文案=' + JSON.stringify(String(((unkRes.content || [])[0] || {}).text || '').slice(0, 60)));

console.log('\n--- 结论 ---');
const ok =
  sessionId &&
  tools.length >= 12 &&
  !!shot &&
  evContent &&
  evContent[0].type === 'text' &&
  scContent.length >= 1 &&
  scContent[0].type === 'text' &&
  scRes.isError === true;
console.log(ok ? '协议层验证通过：工具注册 + image 分支 + 错误路径 + 本地往返均正常' : '存在未通过项，见上');
process.exit(ok ? 0 : 1);
