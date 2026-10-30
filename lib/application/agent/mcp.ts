// MCP 客户端：让插件作为 MCP Client 连接远程 MCP 服务器（Streamable HTTP 传输），
// 把服务器暴露的工具动态合并进 Agent 的工具集（主流做法：客户端连远程 MCP server）。
// 约束：目标服务器源需写入 manifest.json 的 host_permissions（MV3 跨域 fetch 要求）。
import { TOOL_REGISTRY, executeTool, validateToolCall } from './tools.ts';
import { logError } from '../../shared/text.ts';
import type { Caught } from './errors.ts';
import type { McpServerStatus } from './types.ts';

const MCP_PROTOCOL_VERSION = '2024-11-05';
const MCP_TTL = 5 * 60 * 1000; // 工具列表缓存 5 分钟

// 把缓存的「配置指纹 -> client / 工具」记录保存，避免每次对话都重新握手。
//
// 键必须覆盖 url + id + headers：只按 url 做键时，改了 Bearer Token 之后 5 分钟
// 内仍复用旧握手的 client，新 token 根本不会发出去（TITA-11 实测：改完 token 依旧 401，
// 直到缓存过期）。headers 只参与哈希、绝不落日志。
const _mcpCache = new Map(); // cacheKey -> { client, tools, origNames, ts }
// 注意：MCP 工具的「全名 -> client」索引**不能**做成模块级可变态。
// Service Worker 虽是单例，但 Agent 运行是多实例的：早先的实现每次 collectAgentTools
// 都 clear() 全局索引，于是并发运行（多标签页）时先开始的任务会查不到工具、报「未知 MCP 工具」。
// 现在改为每次收集返回独立索引，随运行上下文（ctx.mcpIndex）传递。

// 设置页展示「最近一次连接结果」用的存储键（只存状态与工具数，不存任何 token）。
export const MCP_STATUS_STORAGE_KEY = 'recallflow.mcpLastStatus';

function stableStringify(value: any): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + stableStringify(value[k]))
      .join(',') +
    '}'
  );
}

// FNV-1a（32 位）：同步、无依赖，够用作缓存键。
function hashString(s: any) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** 服务器配置的稳定指纹：url + id + headers 任一变化都会重新握手。 */
export function mcpCacheKey(server: any) {
  const s = server && typeof server === 'object' ? server : {};
  return hashString(stableStringify({ url: s.url || '', id: s.id || '', headers: s.headers || {} }));
}

// HTTP 错误要**指得出原因**：401/403 在 MCP 上几乎总是 token 问题，
// 只回一句「MCP initialize 失败 (403)」时，模型会把它猜成「端口冲突 / 登录页 / 没这个能力」。
// ⚠ 这里绝不拼接 token 本身。
function describeHttpFailure(method: string, status: any, body: any) {
  const detail = String(body || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (status === 401 || status === 403) {
    return (
      'MCP ' + method + ' 失败（HTTP ' + status + '）：鉴权被拒绝（该服务器要求鉴权）。' +
      '请检查设置页「MCP 服务器」里这台服务器的 Authorization（Bearer Token）是否填写、是否与服务端一致' +
      (detail ? '；服务端响应：' + detail : '')
    );
  }
  return 'MCP ' + method + ' 失败（HTTP ' + status + '）' + (detail ? '：' + detail : '');
}

function failWithStatus(message: any, status: any) {
  const err: any = new Error(message);
  if (status) err.status = status;
  return err;
}

class McpClient {
  declare url: string;
  declare headers: any;
  declare sessionId: any;

  constructor(server: any) {
    this.url = server.url;
    this.headers = server.headers || {};
    this.sessionId = null;
  }

  _buildHeaders() {
    const headers = Object.assign(
      {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      this.headers
    );
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    return headers;
  }

  async _rpc(method: string, params: any, id: any) {
    const resp = await fetch(this.url, {
      method: 'POST',
      headers: this._buildHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', method, params: params || {}, id: id || 1 }),
    });

    const sid = resp.headers && resp.headers.get && resp.headers.get('Mcp-Session-Id');
    if (sid) this.sessionId = sid;

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw failWithStatus(describeHttpFailure(method, resp.status, txt), resp.status);
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

  /**
   * 单向通知（notifications/*）：**没有 id、也不应有响应体**。
   * 按普通 RPC 去解析 result 会在空 body / 204 上抛错，所以单独走这条路；
   * 失败只做尽力而为（少数服务器对通知返回 405），真正的连通性由随后的 tools/list 证明。
   */
  async _notify(method: string, params: any) {
    try {
      const resp = await fetch(this.url, {
        method: 'POST',
        headers: this._buildHeaders(),
        body: JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }),
      });
      const sid = resp.headers && resp.headers.get && resp.headers.get('Mcp-Session-Id');
      if (sid) this.sessionId = sid;
      return resp.ok;
    } catch (e) {
      return false;
    }
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

  // Streamable HTTP 要求 initialize 之后客户端补发 notifications/initialized 才算握手完成；
  // 严格的服务端在收到它之前会拒绝 tools/list（TITA-11：这就是「连上了却列不出工具」的一类成因）。
  async notifyInitialized() {
    return this._notify('notifications/initialized', {});
  }

  async listTools() {
    const r = await this._rpc('tools/list', {}, 2);
    return (r && r.tools) || [];
  }

  async callTool(name: string, args: Record<string, unknown>) {
    const r = await this._rpc('tools/call', { name, arguments: args || {} }, 3);
    if (!r || !Array.isArray(r.content)) return '（空结果）';
    return r.content
      .map((c: any) => (c.type === 'text' ? c.text : JSON.stringify(c)))
      .join('\n');
  }
}

function parseSseResult(text: string) {
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

/**
 * 工具名前缀：serverId 必须取「provider 接受的字形」。
 *
 * 用户在设置页填的 id 常带空格（本机的真实配置就是 `Obsidian MCP Server`），
 * 而 function calling 的 name 通常只允许 `[A-Za-z0-9_-]`；原样拼进工具名，
 * provider 一旦校验就整单 400 —— 结果会是「开了 MCP 反而整段对话报错」。
 */
export function mcpToolPrefix(serverId: any) {
  return 'mcp__' + String(serverId || '').replace(/[^A-Za-z0-9_-]/g, '_') + '__';
}

// 把 MCP 工具的 inputSchema 转换为 DeepSeek function-calling 格式，并按 server 命名空间避免重名。
// ⚠ 只输出 schema 允许的字段：`_origName` 这类内部字段曾经被一起发给 provider，
// 既浪费 token 又可能触发严格服务端的 schema 校验；原工具名只在 mcpIndex 里保留。
function mcpToolToDeepSeek(tool: any, serverId: any) {
  const fullName = mcpToolPrefix(serverId) + tool.name;
  return {
    type: 'function',
    function: {
      name: fullName,
      description: '[MCP:' + serverId + '] ' + (tool.description || tool.name),
      parameters: tool.inputSchema || { type: 'object', properties: {} },
    },
  };
}

/** 一次完整握手：initialize → notifications/initialized → tools/list。返回结果状态，不抛异常。 */
export async function probeMcpServer(server: any) {
  const started = Date.now();
  const s = server && typeof server === 'object' ? server : {};
  const base = { serverId: s.id || '', url: s.url || '' };
  try {
    if (!s.url) return Object.assign(base, { ok: false, error: '未配置服务器地址（url 为空）', ts: Date.now() });
    const client = new McpClient(s);
    await client.initialize();
    await client.notifyInitialized();
    const list = await client.listTools();
    return Object.assign(base, { ok: true, toolCount: list.length, ms: Date.now() - started, ts: Date.now() });
  } catch (e) {
    return Object.assign(base, {
      ok: false,
      status: e && (e as Caught).status ? (e as Caught).status : undefined,
      error: String((e && (e as Caught).message) || e),
      ms: Date.now() - started,
      ts: Date.now(),
    });
  }
}

/**
 * 收集 Agent 可用的全部工具：内置工具 + 各 MCP 服务器发现的工具。
 * @param {Object} settings - AI 设置（含 mcpServers: [{id,url,headers}]）
 * @param {Object} [options] - 意图路由过滤
 * @param {Array<string>} [options.allowedTools] - 只保留名单内的内置工具；缺省表示全部
 * @param {boolean} [options.includeMcp] - 是否附带 MCP 工具，默认 true
 * @returns {Promise<{tools: Array, mcpIndex: Map, mcpStatus: Array}>}
 *   DeepSeek tools 数组 + 本次的 MCP 工具索引 + 每台服务器的连接状态
 */
export async function collectAgentTools(settings: any, options: Record<string, any> = {}) {
  // 注意：空数组视为「未限制（全部内置工具）」，而非「只允许空集」。
  // 否则 chat 等未配置白名单的意图会被砍到只剩 alwaysAvailable 工具，模型会误以为环境没有能力。
  const allowed = options.allowedTools && options.allowedTools.length ? new Set(options.allowedTools) : null;
  // 内置工具从统一注册表生成，并按意图白名单过滤；MCP 工具在此基础上按 server namespace 合并。
  // load_skill 标记为 alwaysAvailable，跨意图常驻（普通对话下模型也必须能按需加载技能）。
  const tools = TOOL_REGISTRY.filter((entry) => entry.alwaysAvailable || !allowed || allowed.has(entry.name)).map((entry) => entry.openai);
  // 本次收集专属的 MCP 工具索引（按运行隔离，避免并发运行互相覆盖）。
  const mcpIndex = new Map();
  // 每台服务器的连接结果：失败不再被 logError 静默吞掉，而是随本次运行回传给调用方。
  const mcpStatus: any[] = [];

  if (options.includeMcp === false) return { tools, mcpIndex, mcpStatus };

  const servers = (settings && settings.mcpServers) || [];
  for (const s of servers) {
    if (!s || !s.url) continue;
    const serverId = s.id || '';
    const key = mcpCacheKey(s);
    try {
      let entry = _mcpCache.get(key);
      if (!entry || Date.now() - entry.ts > MCP_TTL) {
        const client = new McpClient(s);
        await client.initialize();
        await client.notifyInitialized();
        const list = await client.listTools();
        const dsTools = [];
        const origNames = new Map();
        for (const t of list) {
          const def = mcpToolToDeepSeek(t, serverId);
          dsTools.push(def);
          origNames.set(def.function.name, t.name);
        }
        entry = { client, tools: dsTools, origNames, ts: Date.now() };
        _mcpCache.set(key, entry);
      }
      for (const t of entry.tools) {
        tools.push(t);
        mcpIndex.set(t.function.name, {
          serverId,
          origName: entry.origNames.get(t.function.name) || String(t.function.name).slice(mcpToolPrefix(serverId).length),
          client: entry.client,
        });
      }
      mcpStatus.push({ serverId, url: s.url, ok: true, toolCount: entry.tools.length, ts: entry.ts });
    } catch (e) {
      const status = Object.assign(
        { serverId, url: s.url, ok: false },
        e && (e as Caught).status ? { status: (e as Caught).status } : {},
        { error: String((e && (e as Caught).message) || e) }
      );
      mcpStatus.push(status);
      logError('MCP 连接失败: ' + (s.url || ''), e);
    }
  }
  return { tools, mcpIndex, mcpStatus };
}

/**
 * 把 MCP 连接状态写成一段给模型的系统提示补充。
 *
 * 为什么必须有这一段：工具列表里没有 MCP 工具时（服务器配了但连不上），
 * 模型只能看到「自己没有这类工具」，于是如实回答「我没有 MCP」——
 * 用户看到的是「配置没生效」，实际是「连不上但没人告诉它」。
 */
export function buildMcpStatusSection(mcpStatus: McpServerStatus[] = []) {
  const list = (Array.isArray(mcpStatus) ? mcpStatus.filter(Boolean) : []) as Array<{ serverId?: string; url?: string; ok?: boolean; toolCount?: number; error?: string }>;
  if (!list.length) return '';
  const lines = ['【MCP 服务器（用户自己配置的外部能力）】工具名规则：`mcp__<serverId>__<工具名>`（serverId 里的空格等字符会替换成 `_`）。'];
  for (const st of list) {
    const name = st.serverId || st.url;
    if (st.ok) {
      lines.push(
        '- ' + name + '（' + st.url + '）：已连接，提供 ' + st.toolCount + ' 个工具，直接用 `' + mcpToolPrefix(st.serverId) + '<工具名>` 调用。'
      );
    } else {
      lines.push(
        '- ' + name + '（' + st.url + '）：**已配置但本次连接失败** —— ' + (st.error || '未知原因') + '。' +
          '这是连接问题，不是你没有这个能力：请如实告诉用户该服务器当前连不上及原因，' +
          '不要说「我没有 MCP / 我没有这个能力」，也不要用 fetch_webpage 去访问该 MCP 地址探测（那只会得到 401/403）。'
      );
    }
  }
  return lines.join('\n');
}

/** 尽力而为地把最近一次连接结果写到 storage，供设置页展示（不存任何凭据）。 */
export function persistMcpStatus(mcpStatus: any) {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return Promise.resolve();
    return Promise.resolve(
      chrome.storage.local.set({ [MCP_STATUS_STORAGE_KEY]: { ts: Date.now(), servers: mcpStatus || [] } })
    ).catch(() => {});
  } catch (e) {
    return Promise.resolve();
  }
}

/** 工具名对应的服务器本次是否处于失败状态？用于把「未知 MCP 工具」说成人能看懂的原因。 */
function mcpFailureHint(name: string, ctx: any) {
  const statuses = ctx && Array.isArray(ctx.mcpStatus) ? ctx.mcpStatus : null;
  if (!statuses) return '';
  const failed = statuses.filter((s: any) => s && s.ok === false);
  if (!failed.length) return '';
  for (const st of failed) {
    if (st.serverId && String(name).indexOf(mcpToolPrefix(st.serverId)) === 0) {
      return '，因为服务器「' + st.serverId + '」本次连接失败：' + (st.error || '未知原因');
    }
  }
  return '，因为已配置的 MCP 服务器本次均未连接成功';
}

/**
 * 统一工具分发：以 mcp__ 前缀区分 MCP 工具，其余走内置 executeTool。
 * MCP 工具依赖 ctx.mcpIndex（由 collectAgentTools 返回并挂在运行上下文上）。
 */
export async function executeAnyTool(name: string, args: Record<string, unknown>, ctx: any) {
  const validation = validateToolCall(name, args || {});
  if (!validation.ok) return { ok: false, result: validation.error };
  // Bridge tasks have no panel from which to request approval. The caller
  // declares allowRisk up front and this single dispatch point enforces it
  // for both serial and parallel tool execution.
  if (ctx && typeof ctx.agentBudgetGuard === 'function') {
    const verdict = ctx.agentBudgetGuard(name);
    if (verdict && verdict.allowed === false) {
      return {
        ok: false,
        result: String(verdict.reason || '') + '\n' + String(verdict.hint || ''),
      };
    }
  }
  if (typeof name === 'string' && name.indexOf('mcp__') === 0) {
    const index = ctx && ctx.mcpIndex;
    const meta = index && typeof index.get === 'function' ? index.get(name) : null;
    if (!meta) {
      return {
        ok: false,
        result:
          '未知 MCP 工具：' + name + '（本次运行未加载该工具' + mcpFailureHint(name, ctx) +
          '；请确认 MCP 服务器已连接且工具名未被改动）',
      };
    }
    try {
      const out = await meta.client.callTool(meta.origName, args || {});
      return { result: out || '（空结果）' };
    } catch (e) {
      return {
        ok: false,
        result:
          'MCP 调用失败：' + (e as Caught).message +
          '（可重试一次；若持续失败，说明该服务器当前不可用，请改用其它方式或如实告知用户）',
      };
    }
  }
  return executeTool(name, args, ctx);
}
