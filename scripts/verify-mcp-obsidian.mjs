// 真机验收：按 initialize → notifications/initialized → tools/list → tools/call 连真实
// 的 Obsidian `mcp-server` 插件（默认 http://127.0.0.1:27123/mcp），验证「客户端代码」
// 这一侧真的能握手、能列工具、能调用。
//
// 用法：node scripts/verify-mcp-obsidian.mjs [工具名，默认 get_active_file]
//
// 安全：token **只在运行时从插件自己的 data.json 读取**，不写文件、不进日志、
// 不进 git；本脚本只打印状态码 / 工具数 / 是否成功，绝不打印 token 本身。
import fs from 'node:fs';
import { mcpToolPrefix } from '../lib/assistant/mcp.js';

// 与扩展里一致的 serverId（BOSS 的配置就是它），用来估算工具定义真正占多少 token。
const SERVER_ID = process.env.MCP_SERVER_ID || 'Obsidian MCP Server';

const DATA_FILE =
  process.env.MCP_SERVER_DATA_FILE ||
  'C:/Users/mario/Documents/Obsidian Vault/.obsidian/plugins/mcp-server/data.json';
const PORT = Number(process.env.MCP_SERVER_PORT || 0);
const TOOL_NAME = process.argv[2] || 'get_active_file';

function readToken() {
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  const json = JSON.parse(raw);
  const settings = json && json.settings ? json.settings : {};
  const token = String(settings.authToken || '').trim();
  if (!token) throw new Error('data.json 里没读到 settings.authToken');
  return { token, port: PORT || Number(settings.port) || 27123 };
}

const { token, port } = readToken();
const URL_ = 'http://127.0.0.1:' + port + '/mcp';
const HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  Authorization: 'Bearer ' + token,
};

let sessionId = null;
const results = [];

function record(step, status, extra) {
  results.push({ step, status, extra });
  console.log(step.padEnd(30) + 'HTTP ' + status + (extra ? '  ' + extra : ''));
}

async function rpc(method, params, notify) {
  const body = { jsonrpc: '2.0', method };
  if (params !== undefined) body.params = params;
  if (!notify) body.id = Date.now() % 100000;
  const headers = Object.assign({}, HEADERS);
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const res = await fetch(URL_, { method: 'POST', headers, body: JSON.stringify(body) });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  const text = await res.text();
  let data = null;
  if (text) {
    if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
      const lines = text.split('\n').filter((l) => l.trim().startsWith('data:'));
      if (lines.length) data = JSON.parse(lines[lines.length - 1].slice(5).trim());
    } else {
      try {
        data = JSON.parse(text);
      } catch (e) {
        data = null;
      }
    }
  }
  return { status: res.status, ok: res.ok, data, text };
}

// 1) initialize
const init = await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'RecallFlow', version: '3.0.0' },
});
record('initialize', init.status, 'session=' + (sessionId ? '有' : '无'));

// 2) notifications/initialized（通知没有 id）
const notified = await rpc('notifications/initialized', {}, true);
record('notifications/initialized', notified.status);

// 3) tools/list
const list = await rpc('tools/list', {});
const tools = (list.data && list.data.result && list.data.result.tools) || [];
const descChars = tools.reduce((n, t) => n + String(t.description || t.name).length, 0);
const schemaChars = tools.reduce((n, t) => n + JSON.stringify(t.inputSchema || {}).length, 0);
record('tools/list', list.status, '工具数=' + tools.length);

// 4) tools/call
const called = await rpc('tools/call', { name: TOOL_NAME, arguments: {} });
const content = (called.data && called.data.result && called.data.result.content) || [];
const isError = Boolean(called.data && called.data.result && called.data.result.isError);
record('tools/call(' + TOOL_NAME + ')', called.status, '内容块=' + content.length + ' isError=' + isError);

console.log('\n--- 成本（普通对话开启 MCP 后的增量） ---');
// 按扩展真正发给 provider 的形状计算（type/function/name/description/parameters）。
const defs = tools.map((t) => ({
  type: 'function',
  function: {
    name: mcpToolPrefix(SERVER_ID) + t.name,
    description: '[MCP:' + SERVER_ID + '] ' + (t.description || t.name),
    parameters: t.inputSchema || { type: 'object', properties: {} },
  },
}));
const payloadChars = JSON.stringify(defs).length;
console.log('工具数: ' + tools.length);
console.log('描述字符数: ' + descChars + '，schema 字符数: ' + schemaChars);
console.log('估算 token（仅描述/4）: ' + Math.round(descChars / 4));
console.log('工具定义实际字符数: ' + payloadChars + '，估算 token（/4）: ' + Math.round(payloadChars / 4));
console.log('工具名（供核对，不含任何凭据）: ' + tools.map((t) => t.name).join(', '));

console.log('\n--- 结论 ---');
const ok =
  init.ok &&
  init.status === 200 &&
  notified.status < 400 &&
  list.ok &&
  tools.length > 0 &&
  called.ok &&
  content.length > 0;
console.log(ok ? '真机验收通过：握手完整、工具可列、调用有返回' : '存在未通过项，见上');
process.exit(ok ? 0 : 1);
