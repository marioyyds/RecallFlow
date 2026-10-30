// RecallFlow 本机 MCP 桥接的**最小 HTTP JSON-RPC 客户端**（零依赖，node 可直接测）。
//
// 为什么不用 @modelcontextprotocol/sdk：这里只需要四件事 —— initialize 拿会话、
// tools/call 调工具、轮询 agent_task_status、/health 探活。为一个评测脚本拖进整套 SDK
// 会让"装不上就跑不起来"的概率翻倍；而 HTTP JSON-RPC 本身只有几十行。
//
// 与 verify-agent-task.mjs 的关系：那个脚本是**人工自检**（打印结论给用户看）；
// 本模块是**给编排器用的库**（抛错、返回结构化结果），两者共用同一套协议事实。
import http from 'node:http';

export class BridgeError extends Error {
  constructor(message, extra) {
    super(message);
    this.name = 'BridgeError';
    Object.assign(this, extra || {});
  }
}

/** job 终态：与 lib/bridge/agent-job.js 的 JOB_STATE 对齐，不另造同义词。 */
export const TERMINAL_JOB_STATES = Object.freeze(['completed', 'failed', 'cancelled', 'stalled']);

// 连续多少次「seq 不动且响应缺 state/running」才判定为快照异常。
// 一次可能是瞬时抖动；连续三次仍如此，就不是抖动了 —— 此时静默重试只会把
// "已经结束的任务"拖到墙钟超时（见 docs/webarena-eval-report.md 4.4）。
const DEFAULT_MAX_STALE = 3;

export class McpBridgeClient {
  constructor(opts = {}) {
    this.host = opts.host || '127.0.0.1';
    this.port = Number(opts.port) || 7801;
    this.token = String(opts.token || '').trim() || 'recallflow-local-bridge-v1';
    this.clientName = opts.clientName || 'recallflow-webarena';
    this.headers = null;
  }

  _request(method, path, { headers = {}, body = null, timeoutMs = 90000 } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: this.host, port: this.port, method, path, headers, timeout: timeoutMs }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      });
      req.on('timeout', () => req.destroy(new BridgeError('桥接请求超时（' + timeoutMs + 'ms）', { code: 'TIMEOUT' })));
      req.on('error', reject);
      if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
      req.end();
    });
  }

  /** /health：不鉴权的探活。ws=true 表示扩展已连上桥接。 */
  async health(timeoutMs = 5000) {
    try {
      const res = await this._request('GET', '/health', { timeoutMs });
      return JSON.parse(res.body);
    } catch (e) {
      return { up: false, error: String((e && e.message) || e) };
    }
  }

  /** 等扩展连上桥接（agent_task 的前提）。超时抛错。 */
  async waitForExtension(timeoutMs = 30000, pollMs = 500) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await this.health();
      if (last && last.ws) return last;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new BridgeError(
      '扩展未连上桥接（/health ws=false）。确认扩展已加载、已启用、且桥接 Token 与 server 一致。',
      { code: 'NO_EXTENSION', last }
    );
  }

  /** 建立 MCP 会话（initialize + initialized）。返回 this，便于链式调用。 */
  async connect() {
    const res = await this._request('POST', '/mcp', {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'X-RecallFlow-Token': this.token },
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: this.clientName, version: '1' } },
      },
    });
    const sid = res.headers['mcp-session-id'];
    if (!sid) throw new BridgeError('initialize 未返回 mcp-session-id（7801 上的服务在跑吗？）', { code: 'NO_SESSION' });
    this.headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'X-RecallFlow-Token': this.token,
      'mcp-session-id': sid,
    };
    await this._request('POST', '/mcp', { headers: this.headers, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
    return this;
  }

  /** tools/call。返回工具内容的 JSON（RecallFlow 的工具一律返回 JSON 文本）。 */
  async callTool(name, args, { id = 2, timeoutMs = 90000 } = {}) {
    if (!this.headers) await this.connect();
    const res = await this._request('POST', '/mcp', {
      headers: this.headers,
      timeoutMs,
      body: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args || {} } },
    });
    let parsed;
    try {
      parsed = JSON.parse(res.body);
    } catch (e) {
      throw new BridgeError('tools/call 的响应不是 JSON：' + String(res.body).slice(0, 200), { code: 'BAD_RESPONSE' });
    }
    if (parsed.error) throw new BridgeError('MCP 错误：' + JSON.stringify(parsed.error), { code: 'MCP_ERROR' });
    const content = parsed.result && parsed.result.content && parsed.result.content[0];
    const text = content ? content.text : '';
    try {
      return JSON.parse(text);
    } catch (e) {
      return { _raw: text, _isError: Boolean(parsed.result && parsed.result.isError) };
    }
  }

  /** tools/list（探活与能力面核对）。 */
  async listTools({ id = 9 } = {}) {
    if (!this.headers) await this.connect();
    const res = await this._request('POST', '/mcp', {
      headers: this.headers,
      body: { jsonrpc: '2.0', id, method: 'tools/list' },
    });
    const parsed = JSON.parse(res.body);
    return (parsed.result && parsed.result.tools) || [];
  }

  openTab(url) {
    return this.callTool('open_tab', { url }, { id: 20 });
  }

  startAgentTask({ instruction, allowRisk, tabId }) {
    const args = { instruction, allowRisk: allowRisk || ['read'] };
    if (Number.isInteger(tabId)) args.tabId = tabId;
    return this.callTool('agent_task', args, { id: 21 });
  }

  agentTaskStatus({ jobId, sinceSeq, compact = true }) {
    const args = {};
    if (jobId !== undefined) args.jobId = jobId;
    if (sinceSeq !== undefined) args.sinceSeq = sinceSeq;
    args.compact = compact;
    return this.callTool('agent_task_status', args, { id: 22 });
  }

  agentTaskCancel(jobId) {
    return this.callTool('agent_task_cancel', { jobId }, { id: 23 });
  }

  /**
   * 轮询一个 job 直到终态。
   *
   * 为什么必须有**墙钟上限**：扩展侧的审批等待没有超时兜底 ——
   * 一个没人能回答的审批会让 job 永远停在 running（桥接侧 90s 后改判 stalled）。
   * 评测脚本若死等，整批任务会卡在一条上，而不是把这一条如实记为失败继续跑。
   *
   * 收口判据（不能只看 `running === false`）：
   *   1. `ok === true` 且 `state` 是终态 → 直接收口。实测见过 `state` 正确却缺 `running`
   *      的快照；此时死等 `running === false` 会把"已完成"拖成超时。
   *   2. `ok === false` → 显式抛错。job 不存在/服务异常不是"还在跑"，重试只是掩盖。
   *   3. 连续多次 `seq` 不变且 `state`/`running` 都缺失 → 显式抛错。
   *      一次可能是抖动，三次仍是空快照就不是抖动；静默重试会把失败伪装成超时。
   *
   * @param {(progress:{seq:number,state:string,omitted:number,events:number})=>void} [onProgress]
   */
  async waitForJob(jobId, { pollMs = 3000, timeoutMs = 300000, maxStale = DEFAULT_MAX_STALE, onProgress } = {}) {
    const deadline = Date.now() + timeoutMs;
    let seq = 0;
    let last = null;
    let stale = 0;
    while (Date.now() < deadline) {
      const s = await this.agentTaskStatus({ jobId, sinceSeq: seq });
      const nextSeq = s && s.seq !== undefined ? Number(s.seq) || seq : seq;
      const advanced = nextSeq > seq;
      seq = nextSeq;
      last = s;
      if (onProgress) onProgress({ seq, state: s && s.state, omitted: s && s.omitted, events: (s && s.events ? s.events : []).length, raw: s });

      if (!s) {
        stale += 1;
      } else if (s.ok === false) {
        throw new BridgeError('agent_task_status 返回 ok=false（' + (s.error || '未给出原因') + '）', {
          code: 'STATUS_ERROR',
          jobId,
          last: s,
        });
      } else if (s.running === false || TERMINAL_JOB_STATES.includes(s.state)) {
        return s;
      } else if (s.state === undefined && s.running === undefined && !advanced) {
        stale += 1;
      } else {
        stale = 0;
      }

      if (stale >= maxStale) {
        throw new BridgeError(
          'agent_task_status 连续 ' + stale + ' 次返回空快照（缺 state/running，seq 停在 ' + seq + '）；' +
            '不静默重试，按异常收口以免把已完成任务误记为超时。',
          { code: 'STATUS_MISSING_STATE', jobId, last }
        );
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return Object.assign({}, last, { running: true, timedOut: true });
  }
}
