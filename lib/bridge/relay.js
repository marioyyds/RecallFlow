// RecallFlow ↔ opencode 的本地中继：连接本机 MCP server，处理 browser_read 请求。
//
// 传输：HTTP 长轮询为主（扩展 service worker 用 fetch 访问本机最稳），WebSocket 为辅。
// 服务端收到 MCP 工具调用后，优先经 WebSocket 推送；无 WS 时排队等扩展长轮询取走。
//
// 说明：MCP server 由用户显式配置并启动；本中继只做「读页面」，不写数据、不执行代码。
import { executeTool, closeAgentWindow, collectPageDiagnostics, collectElementSource, verifyPageTargets, getToolMetadata, TOOL_REGISTRY } from '../assistant/tools.js';
import { getHandoff, listHandoffs } from '../shared/handoff-store.js';
import { BRIDGE_METHODS } from '../shared/bridge-methods.js';
import { validateBridgeWrite } from '../shared/bridge-write-policy.js';
import { normalizeAllowRisk, checkAgentToolBudget, preApprovedToolNames } from '../shared/bridge-agent-policy.js';
import { AgentJobStore, JOB_STATE } from './agent-job.js';
import { getAISettings } from '../shared/settings.js';
import { getBook } from '../shared/store.js';
import { runAgentStream } from '../assistant/agent.js';
import { screenshotAttempts } from '../shared/utils.js';
import { DEFAULT_SCREENSHOT_BUDGET_MS, captureWithLadder } from '../assistant/screenshot-tool.js';
import * as cdp from '../backend/cdp.js';

const RELAY_HOST = '127.0.0.1:7801';
const RELAY_HTTP = 'http://' + RELAY_HOST;
// WS 的 token 只能放在查询串里：浏览器 WebSocket API 无法设置请求头。
// 这是本文件唯一把 token 放进 URL 的位置（HTTP 通道走请求头）。
function relayWsUrl() {
  return 'ws://' + RELAY_HOST + '/?token=' + encodeURIComponent(relayToken);
}

// 与 MCP server 共享的本地桥接 token。
//
// **默认 token 已恢复（用户明确要求）**：此前这里和 server 侧共用常量
// 'recallflow-local-bridge-v1'，且它出现在 README 里 —— 等于把共享密钥提交进仓库，
// 任何本机进程都能用它冒充扩展、返回伪造的"证据"快照。
// 中间版本一度改成"不配置就不连接"，为了开箱即用又改回默认值。
// 覆盖方式：设置页「桥接 Token」填自定义值，server 侧设同一个 RECALLFLOW_BRIDGE_TOKEN。
export const DEFAULT_BRIDGE_TOKEN = 'recallflow-local-bridge-v1';
let relayToken = '';
let tokenLoaded = false;

let socket = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let httpLoopRunning = false;

async function loadRelayToken() {
  if (tokenLoaded) return relayToken;
  try {
    const settings = await getAISettings();
    relayToken = String((settings && settings.bridgeToken) || '').trim();
  } catch (e) {
    relayToken = '';
  }
  // 留空即用内置默认值（与 server 的默认值一致，因此无需任何配置即可连通）。
  if (!relayToken) relayToken = DEFAULT_BRIDGE_TOKEN;
  tokenLoaded = true;
  return relayToken;
}

function authHeaders() {
  // WS 无法在浏览器端设置请求头，因此 token 只走 HTTP 头与 WS 握手负载，绝不进 URL。
  return relayToken ? { 'X-RecallFlow-Token': relayToken } : {};
}

async function connectWs() {
  if (!(await loadRelayToken())) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  try {
    socket = new WebSocket(relayWsUrl());
  } catch (e) {
    socket = null;
    scheduleReconnect();
    return;
  }
  socket.addEventListener('open', () => {
    try {
      socket.send(JSON.stringify({ type: 'hello', client: 'recallflow-extension' }));
    } catch (e) {}
    startHeartbeat();
  });
  socket.addEventListener('message', (ev) => handleWsMessage(ev.data));
  socket.addEventListener('close', () => {
    socket = null;
    stopHeartbeat();
    scheduleReconnect();
  });
  socket.addEventListener('error', () => {
    try {
      socket.close();
    } catch (e) {}
  });
}

// ---------------- WebSocket（辅助通道） ----------------
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWs();
  }, 8000);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    try {
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
    } catch (e) {}
  }, 25000);
}
function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

async function handleWsMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (e) {
    return;
  }
  if (!msg || msg.id === undefined || !msg.method) return;
  const reply = (payload) => {
    try {
      if (socket && socket.readyState === WebSocket.OPEN) {
        // 回带 session，让服务端把结果路由回发起的那个会话（与 HTTP 通道同理）。
        const out = Object.assign({ id: msg.id }, payload);
        if (msg.session !== undefined && msg.session !== null) out.session = msg.session;
        socket.send(JSON.stringify(out));
      }
    } catch (e) {}
  };
  try {
    reply({ result: await dispatch(msg.method, msg.params || {}) });
  } catch (e) {
    reply({ error: String((e && e.message) || e) });
  }
}

// ---------------- HTTP 长轮询（主通道） ----------------
async function httpLoop() {
  if (httpLoopRunning) return;
  // 没配置 token 就不要开始轮询：否则每 3 秒对 127.0.0.1 发一次注定 401 的请求，
  // 既刷控制台也掩盖真正的原因（用户还没填 token）。
  if (!(await loadRelayToken())) return;
  httpLoopRunning = true;
  while (httpLoopRunning) {
    try {
      const res = await fetch(RELAY_HTTP + '/poll', { cache: 'no-store', headers: authHeaders() });
      const data = await res.json();
      const requests = (data && data.requests) || [];
      for (const req of requests) {
        // req.session 由服务端标注（它是哪个 MCP 会话的请求）。扩展**不解释**这个值，
        // 只在回结果时原样带回去，让服务端把结果路由到正确的会话。
        // 不这么做的话，多客户端并发时 A 可能拿到 B 的页面正文。
        const session = req.session;
        let payload;
        try {
          payload = { id: req.id, result: await dispatch(req.method, req.params || {}) };
        } catch (e) {
          payload = { id: req.id, error: String((e && e.message) || e) };
        }
        if (session !== undefined && session !== null) payload.session = session;
        try {
          await fetch(RELAY_HTTP + '/result', {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
            body: JSON.stringify(payload),
          });
        } catch (e) {}
      }
    } catch (e) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

// ---------------- 请求分发 ----------------
/**
 * 桥接请求分发：MCP 服务端发来的每条请求都进这里。
 *
 * 导出是为了**可测**：本文件此前没有任何测试 import 过它（它引用 chrome / WebSocket
 * 等浏览器全局），于是"分支指向不存在的函数""参数校验写反"这类错误只能在
 * **重载扩展之后**才炸 —— 而那时的现象很容易被误判成"服务端没实现"。
 * 测试里用桩替换浏览器全局后即可直接调用本函数（见 tests/relay-dispatch.test.mjs）。
 */
export async function dispatch(method, params) {
  if (method === 'browser_read') return await browserRead(params);
  // 诊断类统一入口：kind 由 params 指定（桥接方法名 == 扩展工具名，因此参数形状也一致）。
  if (method === 'read_diagnostics') return await readActiveTab('read_diagnostics', params);
  if (method === 'get_element_source') return await readElementSource(params);
  if (method === 'page_health') return await readPageDiagnostics();
  if (method === 'verify_change') return await readVerifyChange(params);
  if (method === 'get_picked_element') return await getPickedElement();
  // 交接包：读取用户在浏览器面板里复制出来的会话（凭 RF-XXXXXX 标识）。
  // 存储就在后台可直接访问，无需再经内容脚本。
  if (method === 'handoff_get') return await getHandoff(params && params.id);
  if (method === 'handoff_list') return await listHandoffs(params && params.limit);
  if (method === 'screenshot_capture') return await screenshotCapture(params);
  if (method === 'open_tab') return await openTabViaBridge(params);
  if (method === 'agent_task') return await agentTaskStart(params);
  if (method === 'agent_task_status') return await agentTaskStatus(params);
  if (method === 'agent_task_cancel') return await agentTaskCancel(params);
  if (method === 'page_action') return await pageAction(params);
  throw new Error('unknown method: ' + method);
}

// ---------------- agent 任务（agent_task）：把一整条任务交给扩展内 agent ----------------
//
// 为什么要这条通道：用 page_action 串完一条流程，每一步都要一次 MCP 往返、
// 每一步的快照都进调用方的上下文。整任务交给扩展内 agent 后，
// 快照只在扩展内流转，往返从"每步一次"降到"一次启动 + 轮询进度"。
//
// **为什么必须异步**：桥接等扩展响应默认 60000ms、DSH 的 MCP 调用 90000ms，
// 而一条真实流程是分钟级。同步等必然超时，所以这里立刻返回 jobId，
// 进度用 agent_task_status 按游标轮询（见 lib/bridge/agent-job.js）。
//
// **授权形态**：桥接场景没有面板，没人能点审批（agent 循环等的就是面板应答），
// 因此授权改为「开工前声明 allowRisk」+「执行前逐个判定」：
//   · 判定在 executeAnyTool 的唯一汇合点（ctx.agentBudgetGuard），覆盖串行与并行两条路径；
//   · 同时把已声明类别里"本身会走审批"的工具预填进 sessionApprovedTools，
//     否则 agent 会卡在等一个永远不会有人回答的审批上（见 preApprovedToolNames 的说明）。
const agentJobs = new AgentJobStore();
// jobId -> AbortController。取消要能真的传到 agent 循环（它接受 signal），
// 否则"取消"只是把状态标一下，任务照跑 —— 那比不提供取消更糟。
const cancelControllers = new Map();

// 扩展内 agent 的运行入口。**测试注入点**（刻意很小、只在测试里用）：
// 真实实现要调模型（需要 API Key、会产生费用、且耗时不可控），
// 而"并发拒绝""取消""任务期间禁止外部动页面"这几条恰恰需要任务**稳定处于 running** 才测得了。
// 注入后即可确定性地驱动这些路径，不必真调模型。
// 注意：生产路径不做任何注入，`agentRunner` 始终是 runAgentStream。
let agentRunner = runAgentStream;

/** 仅供测试：替换 agent 运行入口。传 null 恢复真实实现。 */
export function __setAgentRunnerForTests(fn) {
  agentRunner = typeof fn === 'function' ? fn : runAgentStream;
}

/** 创建 job 的假 port：把 agent 的 emit 落进 job，审批请求一概不放行。 */
function agentJobPort(jobId) {
  return {
    postMessage(msg) {
      agentJobs.append(jobId, msg);
    },
    onMessage: {
      addListener() {},
      removeListener() {},
    },
    // 桥接没有面板可弹，审批一律不批准（即"不许执行"）。
    // 正常情况下走不到这里：已声明类别的工具已被预放行，未声明的在执行前就被 guard 拒了。
    requestApproval() {
      return Promise.resolve('reject');
    },
  };
}

/** 供 page_action / open_tab 判断"现在能不能动页面"。 */
function agentJobConflict() {
  const running = agentJobs.running();
  if (!running) return null;
  return {
    ok: false,
    code: 'AGENT_TASK_RUNNING',
    error:
      '已有一个 agent 任务在操作浏览器（jobId=' + running.id + '），因此页面动作被暂时拒绝。' +
      '两个执行者同时动手会互相踩标签页（表现为"两边都点了一下"）。',
    hint: '用 agent_task_status 查看它的进度；需要中止就先 agent_task_cancel。',
  };
}

async function agentTaskStart(params) {
  const p = params || {};
  const instruction = String(p.instruction || '').trim();
  if (!instruction) {
    return { ok: false, error: 'agent_task 需要 instruction（要让扩展内 agent 完成的任务）。' };
  }
  // 授权先归一化：high 与未知类别在这里就被拒（而不是等它跑到一半才失败）。
  const norm = normalizeAllowRisk(p.allowRisk);
  if (!norm.ok) return { ok: false, error: norm.error, code: 'BAD_ALLOW_RISK' };

  // 并发：单任务串行（见 agent-job.js 的说明）。第二个任务被明确拒绝并给出当前 jobId。
  const created = agentJobs.create({ instruction, allowRisk: [...norm.set], tabId: p.tabId });
  if (!created.ok) {
    return { ok: false, error: created.error, code: 'AGENT_TASK_BUSY', runningJobId: created.runningJobId };
  }
  const job = created.job;

  const controller = new AbortController();
  cancelControllers.set(job.id, controller);
  const port = agentJobPort(job.id);
  const guard = (name) => checkAgentToolBudget(name, norm.set, { getMetadata: getToolMetadata });
  const approved = preApprovedToolNames(norm.set, TOOL_REGISTRY.map((t) => t.name), {
    getMetadata: getToolMetadata,
  });

  // **后台跑，不 await** —— 这是让分钟级任务活过 60s 桥接超时的关键。
  (async () => {
    try {
      const settings = await getAISettings();
      // API Key 前置检查：不查的话任务会开工即失败，而错误来自 LLM 层，容易被看成本地故障。
      if (!settings.apiKey) {
        agentJobs.finish(job.id, JOB_STATE.FAILED, {
          error: '尚未配置 API Key（扩展设置页填写后重试）。扩展内 agent 需要它才能规划与执行。',
        });
        return;
      }
      const book = await getBook().catch((e) => {
        // 知识库（IndexedDB）坏了不应该让整条浏览器任务直接失败：
        // agent 没有知识也能跑，而 IndexedDB 不可用的原因（测试桩、隐私模式）与任务本身无关。
        // 只记录，不静默吞掉。真正的任务失败仍由后面的 agentRunner 决定。
        try { console.warn('[relay] 读取知识库失败，本次任务以空知识库启动：' + String((e && e.message) || e)); } catch (_) {}
        return {};
      });
      const tab = p.tabId ? await chrome.tabs.get(Number(p.tabId)).catch(() => null) : await activeTab();
      // 风险预算判定必须**经 settings 传进去**：runAgentStream 自己造 ctx，
      // 调用方没有参数能塞进 ctx。挂错地方不会报错，只会静默放行 —— 见 agent.js 里该键的说明。
      // settings 只作为只读快照使用，绝不写回 storage，所以这个函数不会被序列化落盘。
      const settingsWithGuard = Object.assign({}, settings, { agentBudgetGuard: guard });
      const payload = {
        action: 'agent',
        question: instruction,
        runId: job.id,
        // 预放行清单：让 agent 循环跳过"等面板点同意"那一步（见上方 授权形态 说明）。
        sessionApprovedTools: approved,
      };
      await agentRunner(
        port,
        payload,
        settingsWithGuard,
        book,
        controller.signal,
        tab && tab.id ? tab.id : null
      );
      // 已经落过终态（例如 cancel 抢先标记）就不要覆盖它。
      const cur = agentJobs.get(job.id);
      if (cur && cur.state === JOB_STATE.RUNNING) {
        agentJobs.finish(job.id, JOB_STATE.COMPLETED, { result: String(cur.result || '') });
      }
    } catch (e) {
      // 取消会以 abort 异常的形式冒出来。若不区分，取消就会被记成"失败"，
      // 调用方据此会去查一个不存在的故障。
      const cur = agentJobs.get(job.id);
      const cancelled = cur && (cur.state === JOB_STATE.CANCELLED || cur.cancelRequested);
      agentJobs.finish(job.id, cancelled ? JOB_STATE.CANCELLED : JOB_STATE.FAILED, {
        error: cancelled ? '任务已按请求取消。' : 'Agent 运行出错：' + String((e && e.message) || e),
      });
    } finally {
      cancelControllers.delete(job.id);
    }
  })();

  return {
    ok: true,
    jobId: job.id,
    state: job.state,
    approvedTools: approved,
    allowRisk: [...norm.set],
    note:
      '任务已在后台启动。用 agent_task_status(jobId, sinceSeq) 按游标读进度；' +
      '任务期间 page_action 会被拒绝（避免两个执行者抢同一个标签页）。',
  };
}

async function agentTaskStatus(params) {
  const p = params || {};
  // 先收割"卡住"的任务：扩展侧没有超时兜底（等审批会永远挂住），
  // 不收割的话调用方会一直轮询一个永远不会出终态的 job，且看不出是卡住还是在干活。
  agentJobs.reapStale();
  const jobId = String(p.jobId || '').trim();
  if (!jobId) {
    // 不传 jobId 时给一个可用的清单，而不是报错 —— 调用方多半只是想知道"现在有没有在跑"。
    const running = agentJobs.running();
    return {
      ok: true,
      runningJobId: running ? running.id : '',
      jobs: [...agentJobs.jobs.values()].map((j) => ({
        jobId: j.id,
        state: j.state,
        instruction: j.instruction.slice(0, 80),
        startedAt: j.startedAt,
      })),
    };
  }
  const r = agentJobs.read(jobId, p.sinceSeq);
  if (!r) return { ok: false, error: '未找到该 job：' + jobId, jobId };
  return Object.assign({ ok: true }, r);
}

async function agentTaskCancel(params) {
  const p = params || {};
  const jobId = String(p.jobId || '').trim();
  const job = jobId ? agentJobs.get(jobId) : agentJobs.running();
  if (!job) return { ok: false, error: '没有可取消的 agent 任务' };
  agentJobs.requestCancel(job.id);
  // 真正终止由 agent 循环响应 AbortSignal 完成；这里不假装已经停了。
  try {
    if (cancelControllers.has(job.id)) cancelControllers.get(job.id).abort();
  } catch (e) {}
  return {
    ok: true,
    jobId: job.id,
    state: agentJobs.get(job.id).state,
    note: '已发出取消信号。用 agent_task_status 确认最终状态（取消是异步的，不会立刻变 cancelled）。',
  };
}

// 导航通道：由外部客户端打开一个页面，作为「驱动一次完整流程」的第一步。
//
// 与 pageAction 同样**不经过** agent 循环的审批（桥接是独立入口），因此必须自己过
// bridge-write-policy：它只放行 http(s)、并明确拒绝 chrome:// 与 file://。
//
// 一条实测出来的坑：`openTab` 的标签页预算靠 `ctx.openedTabCount` 累计，
// 而桥接每次请求都新建 ctx（与面板里那个跨轮存活的 ctx 不同）——
// 于是「累计上限 5」永远不会触发，模型反复开页也拦不住，白烧往返。
// 桥接是**无状态**入口，没法跨请求累计，所以这里改成**单次调用即硬上限**：
// 一次只允许开一个（newTab 的语义本来就是"新开一个"），
// 复用已开页面那条路不受限（它不新增标签页）。
async function openTabViaBridge(params) {
  const p = params || {};
  // 同 pageAction：agent 任务在跑时不要再插进来一个新页面。
  const conflict = agentJobConflict();
  if (conflict) return conflict;
  const verdict = validateBridgeWrite('open_tab', p);
  if (!verdict.ok) return { ok: false, error: verdict.error, code: verdict.code };
  try {
    const res = await executeTool(
      'open_tab',
      { url: p.url, newTab: p.newTab === true },
      {
        // 与 pageAction 同源的活动标签页上下文：让 openTab 的"隔离模式/绑定会话"照常工作。
        tabId: null,
        pageUrl: '',
        pageTitle: '',
        openedTabCount: 0,
        maxOpenedTabs: 1,
      }
    );
    if (!res || res.ok === false) {
      return {
        ok: false,
        error: (res && res.result) || '打开标签页失败',
        blocked: Boolean(res && res.blocked),
      };
    }
    return {
      ok: true,
      tabId: res.targetTabId,
      reused: Boolean(res.reused),
      pageUrl: (res.targetTab && res.targetTab.url) || p.url,
      pageTitle: (res.targetTab && res.targetTab.title) || '',
      ready: Boolean(res.targetTab && res.targetTab.ready),
      result: res.result || '',
    };
  } catch (e) {
    return { ok: false, error: '打开标签页失败：' + ((e && e.message) || e) };
  }
}

// 页面动作的目标标签页。
//
// 为什么不能只用"当前活动标签页"：外部客户端驱动流程时，用户随时可能切走窗口，
// 下一步动作就会打在**错误的页面**上；而这类错误看起来像"点击没生效"，
// 比报错更难查。因此允许调用方显式指定 tabId（通常来自 open_tab 的返回值）。
async function resolveActionTab(explicitTabId) {
  const id = Number(explicitTabId);
  if (Number.isInteger(id) && id > 0) {
    const t = await chrome.tabs.get(id).catch(() => null);
    if (t && t.id) return t;
    // 指定的标签页已不存在 → 明确报错，不静默退回活动标签页。
    // 静默退回是危险的：动作会落到用户当前正在看的页面上。
    throw new Error('指定的标签页不存在或已关闭：tabId=' + id + '。请重新 open_tab 获取新的 tabId。');
  }
  return await activeTab();
}

// 写入通道：外部客户端驱动的页面动作。
//
// 为什么需要它：文档承诺的前端调试闭环是「元素 → 源码 → 改代码 → 断言渲染结果」，
// 但此前 MCP 面只有 12 个**只读**工具 —— 外部 agent 无法点击/输入，
// 于是既复现不了 bug（没有交互就没有请求），也验证不了修复（触发不了动作）。
//
// 目标标签页：默认打在当前活动标签页上（前端调试场景就是"用户正在看的那个页面"）；
// 调用方也可以显式传 tabId 锁定目标 —— 驱动多步流程时必须这样，
// 否则用户一切走窗口，动作就会落到别的页面上（见 resolveActionTab）。
//
// 安全边界：本函数**不**复用 agent 循环的审批（那条路在 agent.js 里），
// 因此必须自己过一遍 bridge-write-policy 的白名单；未列出的工具一律拒绝并给出替代路径。
async function pageAction(params) {
  const p = params || {};
  // 有 agent 任务在跑时拒绝外部页面动作：两个执行者同时动手会互相踩标签页。
  const conflict = agentJobConflict();
  if (conflict) return conflict;
  const verdict = validateBridgeWrite(p.tool, p.args || {});
  if (!verdict.ok) return { ok: false, error: verdict.error, code: verdict.code };
  // 目标标签页优先取调用方显式给的 tabId（见 resolveActionTab 的取舍说明）。
  const tab = await resolveActionTab(p.tabId);
  if (!tab || !tab.id) return { ok: false, error: '未找到活动标签页（请先让用户切到要调试的页面）', code: 'NO_ACTIVE_TAB' };
  const ctx = { tabId: tab.id, pageUrl: tab.url || '', pageTitle: tab.title || '' };
  const res = await executeTool(verdict.name, p.args || {}, ctx);
  return {
    ok: res && res.ok !== false,
    tool: verdict.name,
    result: (res && res.result) || '',
    // 把观测到的验证字段原样带出去：外部 agent 判断"这一步真的生效了吗"靠的就是它。
    verification: (res && res.verification) || null,
    hadEffect: Boolean(res && res.hadEffect),
    tabId: ctx.tabId,
    pageUrl: ctx.pageUrl,
  };
}

// 供上层做「清单 ↔ 分支」一致性核对（见 tests/bridge-contract.test.mjs）：
// 清单里有但这里没分支 = 调用方会收到 unknown method。
export const SUPPORTED_BRIDGE_METHODS = BRIDGE_METHODS;

// 截图：MCP 客户端请求当前页面的一张图（给有视觉能力的模型，或留档备查）。
// 图片体积只能靠 format/quality 控制（Page.captureScreenshot 不支持缩放），
// 因此沿用与内置 take_screenshot 相同的降质阶梯，避免超长 base64 撑爆桥接消息。
async function screenshotCapture(params) {
  const p = params || {};
  let tabId = null;
  try {
    const tab = await activeTab();
    tabId = tab && tab.id;
  } catch (e) {
    tabId = null;
  }
  if (!tabId) return { ok: false, error: '没有可截图的活动标签页' };
  // 尊重用户的设置开关：关闭 CDP 时不偷偷截图。
  try {
    const settings = await getAISettings();
    if (settings && settings.cdpEnabled === false) {
      return { ok: false, error: 'CDP 已在设置中关闭，截图不可用' };
    }
  } catch (e) {
    /* 设置读不到时不阻断，交由 isCdpAvailable 决定 */
  }
  if (!cdp.isCdpAvailable()) return { ok: false, error: 'CDP 不可用（debugger API 未就绪）' };

  const wantPng = p.format === 'png';
  const ladder = screenshotAttempts(wantPng ? 'png' : 'jpeg', p.quality);
  // ⚠ 与面板侧同一套实现（`captureWithLadder`）：
  //   · 单张体积上限与总预算共用同一个常量（两份真值必然漂移）；
  //   · 阶梯必须有**总预算**并按剩余预算下传超时 —— 否则三档各等默认 8s = 24s+，
  //     调用方（外部 agent）等不到就会把自己的超时算在扩展头上；
  //   · 失败要**区分"超时"与"附加失败"**：两者的下一步动作不同（前者该换读法，
  //     后者多半是 DevTools 占用了调试器）。原实现一律报"无法附加"，把人指错方向 ✗
  const shot = await captureWithLadder({
    cdp,
    tabId,
    ladder,
    budgetMs: DEFAULT_SCREENSHOT_BUDGET_MS,
    fullPage: p.fullPage === true,
  });
  const data = shot.data;
  const used = shot.used;
  const degraded = shot.degraded;
  if (!data) {
    return {
      ok: false,
      error: shot.timedOut
        ? '截图超时：CDP 未在 ' + DEFAULT_SCREENSHOT_BUDGET_MS + 'ms 预算内响应（页面过重或调试器被占用）。可改用 browser_read / page_action 取结构化信息。'
        : '截图失败：CDP 无法附加到该标签页（可能被其它调试工具占用）。',
    };
  }

  let width = 0;
  let height = 0;
  try {
    // 同一份预算（阶梯留下的 deadline）：这一步也是 CDP 命令，不该各自重新起算。
    const m = await cdp.command(tabId, 'Page.getLayoutMetrics', {}, { timeoutMs: Math.max(400, shot.deadline - Date.now()) });
    const box = p.fullPage === true ? m.cssContentSize || m.contentSize : m.cssVisualViewport || m.visualViewport;
    if (box) {
      width = Math.round(box.clientWidth || box.width || 0);
      height = Math.round(box.clientHeight || box.height || 0);
    }
  } catch (e) {}
  return {
    ok: true,
    image: {
      data,
      mimeType: used.format === 'png' ? 'image/png' : 'image/jpeg',
      width,
      height,
      bytes: Math.round((data.length * 3) / 4),
      format: used.format,
      quality: used.quality,
      degraded,
    },
  };
}

// 返回用户最近在页面上「选取」的元素（选择器 + 标签 + 文本 + 前端源码位置）。
async function getPickedElement() {
  try {
    const d = await chrome.storage.local.get(['recallflow.lastPicked', 'recallflow.lastPickedList']);
    const picked = d && d['recallflow.lastPicked'];
    const list = (d && d['recallflow.lastPickedList']) || [];
    if (!picked || !picked.selector) return { found: false };
    return { found: true, picked, list };
  } catch (e) {
    return { found: false, error: e.message };
  }
}

// 读取用户「当前活动标签页」的运行时信息（console / network），用于前端调试。
async function activeTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return (tabs && tabs[0]) || null;
  } catch (e) {
    return null;
  }
}

async function readActiveTab(kind, params) {
  const tab = await activeTab();
  if (!tab || !tab.id) throw new Error('未找到活动标签页（请切到要调试的页面）');
  const ctx = { tabId: tab.id, pageUrl: tab.url || '', pageTitle: tab.title || '' };
  const res = await executeTool(kind, params || {}, ctx);
  return { text: (res && res.result) || '' };
}

// 结构化读取元素源码位置（get_element_source）：返回 source 对象而非格式化文本，
// 让 MCP 侧按字段归一化，不再依赖「元素源码位置：」这类文案。
async function readElementSource(params) {
  const tab = await activeTab();
  if (!tab || !tab.id) throw new Error('未找到活动标签页（请切到要调试的页面）');
  return await collectElementSource(tab.id, params || {});
}

// 结构化页面诊断（page_health）：返回原始条目而非文本，
// 以便 MCP 侧用 at 时间戳做增量游标、用 stack 定位源码。
async function readPageDiagnostics() {
  const tab = await activeTab();
  if (!tab || !tab.id) throw new Error('未找到活动标签页（请切到要调试的页面）');
  const data = await collectPageDiagnostics(tab.id);
  return {
    found: true,
    tabId: tab.id,
    pageUrl: tab.url || '',
    pageTitle: tab.title || '',
    console: (data && data.console) || [],
    network: (data && data.network) || [],
    consoleError: (data && data.consoleError) || '',
    networkError: (data && data.networkError) || '',
  };
}

// 改完代码后的验证：一次往返同时拿到「目标元素的渲染态」与「运行时诊断」，
// 保证两部分证据取自同一时刻，避免两次读取之间的页面变化造成误判。
async function readVerifyChange(params) {
  const tab = await activeTab();
  if (!tab || !tab.id) throw new Error('未找到活动标签页（请切到要调试的页面）');
  const targets = (params && params.targets) || [];
  const [states, diag] = await Promise.all([
    verifyPageTargets(tab.id, targets),
    collectPageDiagnostics(tab.id),
  ]);
  return {
    found: true,
    tabId: tab.id,
    pageUrl: tab.url || '',
    pageTitle: tab.title || '',
    targets: (states && states.targets) || [],
    targetsError: (states && states.found === false && states.reason) || '',
    console: (diag && diag.console) || [],
    network: (diag && diag.network) || [],
    consoleError: (diag && diag.consoleError) || '',
    networkError: (diag && diag.networkError) || '',
  };
}

// 按 maxChars 截断正文，并如实标注截断（纯函数，便于直测）。
// 为什么单独抽出来：截断的**语义**容易写错 —— 不说清"这是片段"，
// 调用方会把部分正文当成全文，进而基于不完整内容下结论。
//
// ⚠ 还差半句（本仓库对截断的判据是"给可恢复 id，或明确说取不回 + 怎么取"）：
// 原文**没有**留在任何暂存里 ⇒ 不要暗示"可以用 id 取回"；能做的只有"调大 maxChars 重读"，
// 所以那句话必须写出来，否则调用方只知道"少了"，不知道下一步该做什么。
export function truncateEvidenceText(input, maxChars) {
  const full = String(input === undefined || input === null ? '' : input);
  const limit = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0 ? Math.floor(Number(maxChars)) : 12000;
  if (full.length <= limit) return { text: full, truncated: false, fullChars: full.length };
  return {
    text:
      full.slice(0, limit) +
      '\n…（正文共 ' + full.length + ' 字符，已按 maxChars=' + limit + ' 截断；' +
      '**被截掉的部分无法用 id 取回**，需要时请用更大的 maxChars 重新调用 browser_read）',
    truncated: true,
    fullChars: full.length,
  };
}

// 用隔离窗口打开 URL、读取渲染后正文、返回；读取完自动关闭窗口。
async function browserRead(params) {
  const url = String(params.url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('browser_read 仅支持 http/https URL');
  // 这两个参数此前**被静默丢弃**（MCP 侧 schema 声明了、也转发了，这里却不读）：
  //   waitFor  → SPA 上等待元素出现，否则会读到空壳页面（表现为「挂住/正文为空」）
  //   maxChars → 正文上限，否则整页正文灌进上下文（默认 12000 见 MCP schema）
  const waitFor = String((params && params.waitFor) || '').trim();
  const maxCharsRaw = Number(params && params.maxChars);
  const maxChars = Number.isFinite(maxCharsRaw) && maxCharsRaw > 0 ? Math.floor(maxCharsRaw) : 12000;
  const ctx = {
    browsingMode: 'isolated',
    maxOpenedTabs: 8,
    openedTabs: [],
    openedTabCount: 0,
  };
  const opened = await executeTool('open_tab', { url }, ctx);
  if (!opened || opened.ok === false) throw new Error((opened && opened.result) || '打开页面失败');
  ctx.tabId = opened.targetTabId;
  if (opened.targetTab) {
    ctx.pageUrl = opened.targetTab.url || '';
    ctx.pageTitle = opened.targetTab.title || '';
  }
  // 等待目标选择器出现。wait_for_element 自身带超时并返回结构化结果，
  // 失败时**不抛错**：SPA 里该元素可能本来就不需要，继续读取正文比直接失败更有用。
  let waitError = '';
  if (waitFor) {
    try {
      const waited = await executeTool('wait_for_element', { selector: waitFor, state: 'visible' }, ctx);
      if (waited && waited.ok === false) waitError = String(waited.result || '等待超时').slice(0, 200);
    } catch (e) {
      waitError = String((e && e.message) || e).slice(0, 200);
    }
  }
  let text = '';
  try {
    const read = await executeTool('read_current_page', {}, ctx);
    text = String((read && read.result) || '');
    text = text.replace(/^页面标题：[^\n]*\n页面URL：[^\n]*\n\n/, '');
  } finally {
    try {
      await closeAgentWindow(ctx);
    } catch (e) {}
  }
  const finalUrl = (opened.targetTab && opened.targetTab.url) || url;
  const title = (opened.targetTab && opened.targetTab.title) || '';
  // 生效 maxChars：截断要**如实说明**，否则调用方会以为拿到了全文。
  const cut = truncateEvidenceText(text, maxChars);
  text = cut.text;
  return {
    url: finalUrl,
    title,
    text,
    quotes: [],
    // 等待超时不当作失败，但必须让调用方看见 —— 否则「页面是空壳」会被误当成「页面本来就没内容」。
    waitError: waitError || undefined,
    truncated: cut.truncated,
    fullChars: cut.fullChars,
  };
}

// ---------------- 启动 ----------------
let started = false;
export function startMcpRelay() {
  connectWs();
  httpLoop();
  if (started) return;
  started = true;
  // 用 chrome.alarms 周期性确保长轮询/连接存活：MV3 service worker 休眠后
  // 循环会停，alarm 能唤醒 worker 并重启轮询（自愈）。
  try {
    if (chrome && chrome.alarms) {
      chrome.alarms.create('recallflow-relay', { periodInMinutes: 1 });
      chrome.alarms.onAlarm.addListener((a) => {
        if (a && a.name === 'recallflow-relay') {
          connectWs();
          httpLoop();
        }
      });
    }
  } catch (e) {}
}
