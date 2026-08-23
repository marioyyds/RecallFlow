// MCP 客户端：让插件作为 MCP Client 连接远程 MCP 服务器（Streamable HTTP 传输），
// 把服务器暴露的工具动态合并进 Agent 的工具集（主流做法：客户端连远程 MCP server）。
// 约束：目标服务器源需写入 manifest.json 的 host_permissions（MV3 跨域 fetch 要求）。
import { TOOL_REGISTRY, executeTool, validateToolCall } from './tools.js';
import { logError } from '../shared/utils.js';

const MCP_PROTOCOL_VERSION = '2024-11-05';
const MCP_TTL = 5 * 60 * 1000; // 工具列表缓存 5 分钟

// 把缓存的 serverId -> client / 工具 记录保存，避免每次对话都重新握手
const _mcpCache = new Map(); // url -> { client, tools, ts }
const mcpToolIndex = new Map(); // deepseek 工具全名 -> { serverId, origName, client }

class McpClient {
  constructor(server) {
    this.url = server.url;
    this.headers = server.headers || {};
    this.sessionId = null;
  }

  async _rpc(method, params, id) {
    const headers = Object.assign(
      {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      this.headers
    );
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;

    const resp = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', method, params: params || {}, id: id || 1 }),
    });

    const sid = resp.headers && resp.headers.get && resp.headers.get('Mcp-Session-Id');
    if (sid) this.sessionId = sid;

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error('MCP ' + method + ' 失败 (' + resp.status + '): ' + txt.slice(0, 300));
    }

    const ct = (resp.headers && resp.headers.get && resp.headers.get('content-type')) || '';
    let data;
    if (ct.includes('text/event-stream')) {
      data = parseSseResult(await resp.text());
    } else {
      data = await resp.json();
    }
    if (data && data.error) throw new Error('MCP 错误：' + JSON.stringify(data.error));
    return data ? data.result : null;
  }

  async initialize() {
    return this._rpc(
      'initialize',
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'RecallFlow', version: '3.0.0' },
      },
      1
    );
  }

  async listTools() {
    const r = await this._rpc('tools/list', {}, 2);
    return (r && r.tools) || [];
  }

  async callTool(name, args) {
    const r = await this._rpc('tools/call', { name, arguments: args || {} }, 3);
    if (!r || !Array.isArray(r.content)) return '（空结果）';
    return r.content
      .map((c) => (c.type === 'text' ? c.text : JSON.stringify(c)))
      .join('\n');
  }
}

function parseSseResult(text) {
  const lines = String(text).split('\n');
  let last = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const d = t.slice(5).trim();
    if (!d || d === '[DONE]') continue;
    try {
      const j = JSON.parse(d);
      last = j;
    } catch (e) {
      /* 跳过非 JSON 的 SSE 行 */
    }
  }
  return last;
}

// 把 MCP 工具的 inputSchema 转换为 DeepSeek function-calling 格式，并按 server 命名空间避免重名
function mcpToolToDeepSeek(tool, serverId) {
  const fullName = 'mcp__' + serverId + '__' + tool.name;
  return {
    type: 'function',
    function: {
      name: fullName,
      description: '[MCP:' + serverId + '] ' + (tool.description || tool.name),
      parameters: tool.inputSchema || { type: 'object', properties: {} },
    },
    _origName: tool.name,
  };
}

/**
 * 收集 Agent 可用的全部工具：内置工具 + 各 MCP 服务器发现的工具。
 * @param {Object} settings - AI 设置（含 mcpServers: [{id,url,headers}]）
 * @param {Object} [options] - 意图路由过滤
 * @param {Array<string>} [options.allowedTools] - 只保留名单内的内置工具；缺省表示全部
 * @param {boolean} [options.includeMcp] - 是否附带 MCP 工具，默认 true
 * @returns {Promise<Array>} DeepSeek tools 数组
 */
export async function collectAgentTools(settings, options = {}) {
  // 注意：空数组视为「未限制（全部内置工具）」，而非「只允许空集」。
  // 否则 chat 等未配置白名单的意图会被砍到只剩 alwaysAvailable 工具，模型会误以为环境没有能力。
  const allowed = options.allowedTools && options.allowedTools.length ? new Set(options.allowedTools) : null;
  // 内置工具从统一注册表生成，并按意图白名单过滤；MCP 工具在此基础上按 server namespace 合并。
  // load_skill 标记为 alwaysAvailable，跨意图常驻（普通对话下模型也必须能按需加载技能）。
  const tools = TOOL_REGISTRY.filter((entry) => entry.alwaysAvailable || !allowed || allowed.has(entry.name)).map((entry) => entry.openai);
  mcpToolIndex.clear();

  if (options.includeMcp === false) return tools;

  const servers = (settings && settings.mcpServers) || [];
  for (const s of servers) {
    if (!s || !s.url) continue;
    try {
      let entry = _mcpCache.get(s.url);
      if (!entry || Date.now() - entry.ts > MCP_TTL) {
        const client = new McpClient(s);
        await client.initialize();
        const list = await client.listTools();
        const dsTools = list.map((t) => mcpToolToDeepSeek(t, s.id));
        entry = { client, tools: dsTools, ts: Date.now() };
        _mcpCache.set(s.url, entry);
      }
      for (const t of entry.tools) {
        tools.push(t);
        mcpToolIndex.set(t.function.name, { serverId: s.id, origName: t._origName, client: entry.client });
      }
    } catch (e) {
      logError('MCP 连接失败: ' + (s.url || ''), e);
    }
  }
  return tools;
}

/**
 * 统一工具分发：以 mcp__ 前缀区分 MCP 工具，其余走内置 executeTool。
 */
export async function executeAnyTool(name, args, ctx) {
  const validation = validateToolCall(name, args || {});
  if (!validation.ok) return { ok: false, result: validation.error };
  if (typeof name === 'string' && name.indexOf('mcp__') === 0) {
    const meta = mcpToolIndex.get(name);
    if (!meta) return { result: '未知 MCP 工具：' + name };
    try {
      const out = await meta.client.callTool(meta.origName, args || {});
      return { result: out || '（空结果）' };
    } catch (e) {
      return { result: 'MCP 调用失败：' + e.message };
    }
  }
  return executeTool(name, args, ctx);
}
