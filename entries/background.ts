// Service Worker 入口（ES Module）：AI 请求 / Agent 编排 / 页面命令转发的消息监听
import { getBook } from '../lib/shared/store.ts';
import { getAISettings } from '../lib/shared/settings.ts';
import { buildAiMessages } from '../lib/shared/rag.ts';
import { callDeepSeek } from '../lib/assistant/llm.ts';
import { runAgentStream } from '../lib/assistant/agent.ts';
import { startMcpRelay } from '../lib/bridge/relay.ts';
import { initTargetManager } from '../lib/assistant/target-manager.ts';
import { logError, isOperableUrl } from '../lib/shared/utils.ts';
import { saveHandoff, getHandoff, listHandoffs } from '../lib/shared/handoff-store.ts';
import { sanitizeMessages } from '../lib/shared/surrogates.ts';
import { loadAgentSession } from '../lib/assistant/session-store.ts';
import {
  PanelSessionStore,
  PSESS_INDEX_KEY,
  PSESS_ACTIVE_KEY,
  PSESS_SESSION_PREFIX,
} from '../lib/shared/panel-sessions.ts';
import { RunStreamHub } from '../lib/assistant/run-hub.ts';
import { RunChannel } from '../lib/assistant/run-channel.ts';
import { createIndexedDbKeyValueStore } from '../lib/shared/idb-kv.ts';
import { removeSessionScreenshots } from '../lib/shared/screenshot-store.ts';
import {
  listScripts,
  installFromUrl,
  installFromCode,
  previewScript,
  previewCode,
  updateScript,
  updateAllScripts,
  setScriptEnabled,
  uninstallScript,
  searchScripts,
  runUserscriptOnTab,
  userscriptXhr,
  syncUserscriptRegistrations,
} from '../lib/userscript/manager.ts';

/**
 * 跨上下文消息载荷 / chrome.storage 的读写结果。
 *
 * 这些数据的形状由**发送方**（内容脚本、面板、MCP、旧版 storage）决定，
 * 本文件只按 msg.type 分派 —— 给 40 多种消息各写一份 interface 只会把协议抄成两处，
 * 而协议本身没有可校验的单一来源。因此统一用「任意 JSON 对象」：
 * 字面量就是 chrome.storage 的契约（JSON 文档），不是放弃类型。
 */
type Dyn = Record<string, any>;

/** AbortController 上额外挂的运行标记（run 收尾后置 true，防止重复 abort）。 */
type RunController = AbortController & { __rfFinished?: boolean };

interface PendingRunCleanup {
  tabIds: Set<number>;
  windowId: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const persistentPanelStorage = createIndexedDbKeyValueStore({
  dbName: 'recallflow-history',
  storeName: 'panel-kv',
  version: 1,
});

function isPersistentPanelKey(key: unknown): boolean {
  const k = String(key || '');
  return k === PSESS_INDEX_KEY || k === PSESS_ACTIVE_KEY || k.startsWith(PSESS_SESSION_PREFIX);
}

function splitPanelKeys(keys: unknown) {
  const list = keys == null ? [] : Array.isArray(keys) ? keys : [keys];
  return {
    persistent: list.filter(isPersistentPanelKey),
    session: list.filter((k) => !isPersistentPanelKey(k)),
  };
}

// 会话正文/索引/当前会话写 IndexedDB；面板开合与运行锁仍留在 storage.session，
// 因为它们是浏览器会话级、重启后必须失效的临时状态。
const panelStorage = {
  async get(keys: string | string[] | null): Promise<Dyn> {
    if (keys == null) {
      const [sessionData, persistentData] = await Promise.all([
        chrome.storage.session.get(null),
        persistentPanelStorage.get(null).catch(() => ({})),
      ]);
      return Object.assign({}, sessionData || {}, persistentData || {});
    }
    const parts = splitPanelKeys(keys);
    const out: Dyn = {};
    if (parts.persistent.length) {
      try {
        Object.assign(out, await persistentPanelStorage.get(parts.persistent));
      } catch (e) {
        Object.assign(out, await chrome.storage.session.get(parts.persistent));
      }
    }
    if (parts.session.length) Object.assign(out, await chrome.storage.session.get(parts.session));
    return out;
  },
  async set(items: Dyn) {
    const persistent: Dyn = {};
    const session: Dyn = {};
    for (const [key, value] of Object.entries(items || {})) {
      if (isPersistentPanelKey(key)) persistent[key] = value;
      else session[key] = value;
    }
    const jobs = [];
    if (Object.keys(persistent).length) {
      jobs.push(
        persistentPanelStorage.set(persistent).catch(async () => {
          // IDB 暂时不可用时至少不要让当前会话丢失；下一次启动会重新尝试迁移。
          await chrome.storage.session.set(persistent);
        })
      );
    }
    if (Object.keys(session).length) jobs.push(chrome.storage.session.set(session));
    await Promise.all(jobs);
  },
  async remove(keys: string | string[] | null) {
    const parts = splitPanelKeys(keys);
    const jobs = [];
    if (parts.persistent.length) jobs.push(persistentPanelStorage.remove(parts.persistent).catch(() => {}));
    if (parts.session.length) jobs.push(chrome.storage.session.remove(parts.session));
    await Promise.all(jobs);
  },
};

const panelSessions = new PanelSessionStore({
  storage: panelStorage,
  isTabAlive: (tabId: number) =>
    new Promise<boolean>((resolve) => {
      try {
        chrome.tabs.get(Number(tabId), (tab) => {
          resolve(!chrome.runtime.lastError && Boolean(tab));
        });
      } catch (e) {
        resolve(false);
      }
    }),
});

async function migratePanelStorageToIdb() {
  try {
    const existing = await persistentPanelStorage.get(PSESS_INDEX_KEY);
    if (existing && existing[PSESS_INDEX_KEY]) return;
    const all = (await chrome.storage.session.get(null)) as Dyn;
    const persistentKeys = Object.keys(all || {}).filter(isPersistentPanelKey);
    if (!persistentKeys.length) return;
    const items: Dyn = {};
    for (const key of persistentKeys) items[key] = all[key];
    await persistentPanelStorage.set(items);
    await chrome.storage.session.remove(persistentKeys);
  } catch (e) {
    // IndexedDB 暂不可用：保留 storage.session 数据作为降级，不阻断面板启动。
    console.warn('[RecallFlow] IndexedDB 会话迁移失败，暂用 session storage:', (e as Error | null)?.message);
  }
}

// Service Worker 可能被回收后重新启动；bootstrap 本身是幂等的，但同一生命周期内
// 多个标签页同时打开面板时只应扫描一次旧数据。
let panelBootstrapPromise: Promise<unknown> | null = null;

async function ensurePanelSessions(): Promise<unknown> {
  if (!panelBootstrapPromise) {
    panelBootstrapPromise = (async () => {
      await migratePanelStorageToIdb();
      const all = (await chrome.storage.session.get(null)) as Dyn;
      const legacyEntries = Object.keys(all || {})
        .filter((key) => /^recallflow\.conv\.\d+$/.test(key))
        .map((key) => ({
          key,
          conversation: (all[key] && all[key].conversation) || [],
          updatedAt: (all[key] && all[key].updatedAt) || 0,
        }));
      const state = await panelSessions.bootstrap({ legacyEntries });
      if (state && Array.isArray(state.migratedKeys) && state.migratedKeys.length) {
        try {
          await chrome.storage.session.remove(state.migratedKeys);
        } catch (e) {}
      }
      return state;
    })();
    panelBootstrapPromise = panelBootstrapPromise.catch((e) => {
      // 存储暂时不可用时允许下次消息重新尝试，而不是把会话功能永久判死。
      panelBootstrapPromise = null;
      throw e;
    });
  }
  return panelBootstrapPromise;
}

function panelSummary(state: Dyn) {
  const s = state || {};
  return {
    sessions: Array.isArray(s.sessions) ? s.sessions : [],
    activeId: String(s.activeId || ''),
    seq: Number(s.seq) || 0,
  };
}

/**
 * 会话变更广播：只发摘要，收到消息的标签页按 activeId 再取正文。
 * 不回发给发起写入的标签页，避免它把自己的响应又当成一次远端更新。
 */
function broadcastPanelSessions(state: Dyn, sourceTabId: number | null | undefined) {
  const payload = Object.assign({ type: 'panel:sessions-changed' }, panelSummary(state));
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs || []) {
      if (!tab || tab.id == null || tab.id === sourceTabId) continue;
      if (tab.url && !isOperableUrl(tab.url)) continue;
      chrome.tabs.sendMessage(tab.id, payload, { frameId: 0 }, () => void chrome.runtime.lastError);
    }
  });
}

function broadcastPanelUi(ui: Dyn, sourceTabId: number | null | undefined) {
  const payload = {
    type: 'panel:ui-changed',
    open: Boolean(ui && ui.open),
    seq: Number(ui && ui.seq) || 0,
    updatedAt: Number(ui && ui.updatedAt) || 0,
  };
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs || []) {
      if (!tab || tab.id == null || tab.id === sourceTabId) continue;
      if (tab.url && !isOperableUrl(tab.url)) continue;
      chrome.tabs.sendMessage(tab.id, payload, { frameId: 0 }, () => void chrome.runtime.lastError);
    }
  });
}

// tabId -> 当前订阅的 sessionId。跟随页只在面板打开/会话切换时登记一次，
// SW 按 session 定向广播，避免把每个 token 发给所有网页。
const runSubscriptions = new Map<number, string>();
// runId -> 待关闭的辅助页/Agent 窗口。必须等发起页确认最终消息已落盘后再清。
const pendingRunCleanup = new Map<string, PendingRunCleanup>();

function registerRunCleanup(runId: unknown, event: Dyn) {
  const id = String(runId || '');
  if (!id) return;
  let item = pendingRunCleanup.get(id);
  if (!item) {
    item = { tabIds: new Set(), windowId: null, timer: null };
    pendingRunCleanup.set(id, item);
  }
  for (const tabId of Array.isArray(event && event.tabIds) ? event.tabIds : []) {
    if (Number.isInteger(Number(tabId))) item.tabIds.add(Number(tabId));
  }
  if (Number.isInteger(Number(event && event.windowId))) item.windowId = Number(event.windowId);
  if (item.timer) clearTimeout(item.timer);
  // 兜底：发起页若已崩溃/关闭，不能让辅助页永久残留。
  item.timer = setTimeout(() => finalizeRunCleanup(id), 15_000);
}

function finalizeRunCleanup(runId: unknown) {
  const id = String(runId || '');
  const item = pendingRunCleanup.get(id);
  if (!item) return;
  pendingRunCleanup.delete(id);
  if (item.timer) clearTimeout(item.timer);
  const ids = [...item.tabIds];
  if (ids.length) {
    try {
      chrome.tabs.remove(ids, () => void chrome.runtime.lastError);
    } catch (e) {}
  }
  if (item.windowId) {
    try {
      chrome.windows.remove(item.windowId, () => void chrome.runtime.lastError);
    } catch (e) {}
  }
}

function sendToRunSubscribers(sessionId: unknown, payload: Dyn, excludeTabId: number | null | undefined) {
  const wanted = String(sessionId || '');
  if (!wanted) return;
  for (const [tabId, subscribed] of [...runSubscriptions]) {
    if (subscribed !== wanted) continue;
    if (tabId === excludeTabId) continue;
    // 广播**不等待响应**：run:delta 是单向通知，内容脚本没有 sendResponse。
    // 之前用 callback + chrome.runtime.lastError 判断存活，会把
    // "message port closed before a response was received"（消息其实已送达）
    // 误判成页面死亡并删掉订阅 —— 跟随页只收到第一条 delta，之后只能靠快照轮询。
    try {
      const sending = chrome.tabs.sendMessage(tabId, payload, { frameId: 0 });
      if (sending && typeof sending.catch === 'function') {
        sending.catch((e) => {
          if (/Receiving end does not exist|Could not establish connection/i.test(String((e && e.message) || e))) {
            runSubscriptions.delete(tabId);
          }
        });
      }
    } catch (e) {}
  }
}

const runHub = new RunStreamHub({
  onStart: (snapshot: Dyn) => {
    if (!snapshot) return;
    sendToRunSubscribers(
      snapshot.sessionId,
      {
        type: 'run:started',
        runId: snapshot.runId,
        sessionId: snapshot.sessionId,
        ownerTabId: snapshot.ownerTabId,
        cursor: snapshot.cursor,
      },
      snapshot.ownerTabId
    );
  },
  onDelta: (delta: Dyn) => {
    runStats.hubDeltas += 1;
    sendToRunSubscribers(
      delta.sessionId,
      {
        type: 'run:delta',
        runId: delta.runId,
        sessionId: delta.sessionId,
        ownerTabId: delta.ownerTabId,
        cursor: delta.cursor,
        event: delta.event,
      },
      delta.ownerTabId
    );
  },
  onEnd: (snapshot: Dyn) => {
    if (!snapshot) return;
    sendToRunSubscribers(
      snapshot.sessionId,
      {
        type: 'run:ended',
        runId: snapshot.runId,
        sessionId: snapshot.sessionId,
        cursor: snapshot.cursor,
      },
      snapshot.ownerTabId
    );
  },
});

// 兜底日志：service worker 内未捕获的异常 / Promise 拒绝也打到 console，便于排障。
try {
  self.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    console.error('[RecallFlow] unhandledrejection:', r && (r.stack || r.message) ? (r.stack || r.message) : r);
  });
  self.addEventListener('error', (e) => {
    console.error('[RecallFlow] uncaught error:', e && e.message, e && e.filename, e && e.lineno);
  });
} catch (e) {}

async function handleAi(request: Dyn) {
  const settings = await getAISettings();
  if (!settings.apiKey) {
    return {
      ok: false,
      error: '尚未配置 API Key，请点击插件图标 → 设置页填写。',
      needSetup: true,
    };
  }

  const book = await getBook();
  const messages = buildAiMessages(request.action, request, settings, book);
  if (!messages) {
    return { ok: false, error: '未知操作：' + request.action };
  }

  // 第三个参数是中断信号；本路径没有可中断的 controller，显式传 undefined（与原来只传 2 个参数等价）。
  const answer = await callDeepSeek(settings, messages, undefined);
  return { ok: true, answer };
}

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-panel') return;
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    // 本地页（file://）也要能开面板：用户正看着它，却连快捷键都没反应，是最难解释的那种"坏了"。
    if (!tab || tab.id == null || !isOperableUrl(tab.url || '')) return;
    chrome.tabs.sendMessage(
      tab.id,
      { type: 'panel:toggle' },
      { frameId: 0 },
      () => void chrome.runtime.lastError
    );
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'getTabId') {
    sendResponse({ tabId: sender.tab ? sender.tab.id : null });
    return false;
  }
  if (msg && msg.type === 'ai') {
    handleAi(msg.payload || msg)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg && msg.type === 'openOptions') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }
  if (msg && msg.type === 'openManager') {
    const focusId = msg.focusId || '';
    chrome.tabs.create({ url: chrome.runtime.getURL('manager.html') + (focusId ? '#focus=' + encodeURIComponent(focusId) : '') });
    sendResponse({ ok: true });
    return false;
  }
  // 发起页确认最终 assistant 消息已写入共享会话。此时才允许清理本次 run 的辅助页，
  // 避免“页先关、最后一条回复还没落盘”。
  if (msg && msg.type === 'panel:run:committed') {
    finalizeRunCleanup(msg.runId);
    sendResponse({ ok: true });
    return false;
  }
  // ---- 运行流订阅（跨标签页实时跟随）----
  // 任意跟随页都可以请求停止同一个 run；由 SW 找到 owner tab 的 AbortController。
  if (msg && msg.type === 'panel:run:stop') {
    sendResponse(
      requestRunStop(
        { runId: msg.runId, sessionId: msg.sessionId },
        sender.tab && sender.tab.id
      )
    );
    return false;
  }
  if (msg && (msg.type === 'panel:run:subscribe' || msg.type === 'panel:run:unsubscribe')) {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) {
      sendResponse({ ok: false, error: '缺少标签页上下文' });
      return false;
    }
    if (msg.type === 'panel:run:unsubscribe') {
      runSubscriptions.delete(tabId);
      sendResponse({ ok: true });
      return false;
    }
    const sessionId = String(msg.sessionId || '');
    if (!sessionId) {
      sendResponse({ ok: true, snapshot: null });
      return false;
    }
    const snapshot = runHub.findBySession(sessionId);
    runSubscriptions.set(tabId, sessionId);
    const selfOwned = Boolean(snapshot && Number(snapshot.ownerTabId) === Number(tabId));
    sendResponse({
      ok: true,
      selfOwned,
      snapshot: selfOwned ? null : snapshot,
    });
    return false;
  }
  // ---- 面板开合状态（全浏览器同步）----
  if (msg && msg.type === 'panel:open-active') {
    // popup 作为独立标签页打开时，sender.tab 指向 popup 自己；显式传入的
    // tabId 才是用户正在浏览的网页。优先使用显式值，避免 popup 关闭时
    // 把唯一的面板成员一起删掉。
    const requestedTabId = Number(msg.tabId);
    const targetTabId = Number.isInteger(requestedTabId) && requestedTabId > 0
      ? requestedTabId
      : sender.tab && sender.tab.id;
    if (targetTabId == null || !Number.isInteger(targetTabId) || targetTabId <= 0) {
      sendResponse({ ok: false, error: '缺少目标标签页' });
      return false;
    }
    (async () => {
      await ensurePanelSessions();
      const result = await panelSessions.setUi({ open: true, tabId: targetTabId, scope: 'global' });
      broadcastPanelUi(result.ui, null);
      sendResponse({ ok: true, ui: result.ui });
    })().catch((e) => {
      sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });
    });
    return true;
  }
  if (msg && (msg.type === 'panel:ui:get' || msg.type === 'panel:ui:set')) {
    const sourceTabId = sender.tab && sender.tab.id;
    (async () => {
      if (msg.type === 'panel:ui:get') {
        const ui = await panelSessions.getUi();
        sendResponse({ ok: true, ui });
        return;
      }
      const result = await panelSessions.setUi({
        open: msg.open === true,
        tabId: sourceTabId,
        scope: msg.scope === 'membership' ? 'membership' : 'global',
      });
      sendResponse({ ok: true, ui: result.ui });
      if (result.changed) {
        try {
          broadcastPanelUi(result.ui, sourceTabId);
        } catch (e) {}
      }
    })().catch((e) => {
      sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });
    });
    return true;
  }
  // ---- 面板会话（整个浏览器共享，可新建 / 切换 / 查看历史）----
  //
  // 所有写操作都在 Service Worker 里串行执行（PanelSessionStore 内部队列），
  // 内容脚本只负责发消息与渲染，绝不直接写 storage.session。
  if (msg && /^panel:(state|get|create|save|activate|rename|delete|lock|unlock)$/.test(String(msg.type || ''))) {
    const sourceTabId = sender.tab && sender.tab.id;
    const reply = (body: Dyn) => sendResponse(Object.assign({ ok: true }, body || {}));
    (async () => {
      await ensurePanelSessions();
      // 下面每个分支都会赋值；显式带上 `| undefined` 是为了让「对 const 赋值」门禁
      // 能把它识别成 **let**（`let x!: T` 的 `!` 不在该门禁的声明正则里 —— 那样同名
      // 的内层 `const result` 会被当成唯一声明，赋值就被误报成「对 const 赋值」）。
      let result: Dyn | undefined;
      if (msg.type === 'panel:state') {
        result = await panelSessions.list();
        reply(panelSummary(result));
        return;
      }
      if (msg.type === 'panel:get') {
        result = await panelSessions.get(msg.id);
        reply({
          session: result.session || null,
          activeId: result.activeId || '',
          sessions: result.sessions || [],
        });
        return;
      }
      if (msg.type === 'panel:create') {
        const origin = (sender.tab && sender.tab.url) || msg.origin || '';
        result = await panelSessions.create({
          title: msg.title,
          messages: Array.isArray(msg.messages) ? msg.messages : [],
          handoffId: msg.handoffId,
          origin,
        });
      } else if (msg.type === 'panel:save') {
        result = await panelSessions.save({
          id: msg.id,
          messages: msg.messages,
          baseSeq: msg.baseSeq,
          allowShrink: msg.allowShrink === true,
          title: msg.title,
          handoffId: msg.handoffId,
          lastRunId: msg.lastRunId,
          origin: msg.origin,
          tabId: sourceTabId,
        });
      } else if (msg.type === 'panel:activate') {
        result = await panelSessions.activate(msg.id);
      } else if (msg.type === 'panel:rename') {
        result = await panelSessions.rename(msg.id, msg.title);
      } else if (msg.type === 'panel:delete') {
        result = await panelSessions.remove(msg.id);
        if (result && result.ok) await removeSessionScreenshots(chrome, msg.id).catch(() => {});
      } else if (msg.type === 'panel:lock') {
        result = await panelSessions.lock({
          id: msg.id,
          runId: msg.runId,
          tabId: sourceTabId,
          takeover: msg.takeover === true,
        });
        // 接管时通知原标签页停止本轮，避免两个标签页并发操作同一会话。
        if (result && result.ok && msg.takeover === true && result.lock && result.lock.previous) {
          const oldTabId = Number(result.lock.previous.tabId);
          const oldRunId = String(result.lock.previous.runId || '');
          if (oldTabId) {
            chrome.tabs.sendMessage(
              oldTabId,
              { type: 'panel:lock-lost', id: String(msg.id || ''), runId: oldRunId },
              { frameId: 0 },
              () => void chrome.runtime.lastError
            );
          }
        }
      } else if (msg.type === 'panel:unlock') {
        result = await panelSessions.unlock({ id: msg.id, runId: msg.runId });
        if (result && result.ok) {
          const state = await panelSessions.list();
          result.sessions = state.sessions || [];
          result.activeId = state.activeId || '';
        }
      }
      reply(result || { ok: false, error: '未知会话操作' });
      if (result && result.ok && Array.isArray(result.sessions)) {
        broadcastPanelSessions(result, sourceTabId);
      }
    })().catch((e) => {
      sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });
    });
    return true;
  }
  if (msg && msg.type === 'conv:save') {
    const tabId = sender.tab && sender.tab.id;
    if (tabId != null && Array.isArray(msg.conversation)) {
      try {
        chrome.storage.session.set({ ['recallflow.conv.' + tabId]: { conversation: msg.conversation, updatedAt: Date.now() } });
      } catch (e) {}
    }
    sendResponse({ ok: true });
    return false;
  }
  if (msg && msg.type === 'conv:get') {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) {
      sendResponse({ conversation: [] });
      return false;
    }
    chrome.storage.session
      .get('recallflow.conv.' + tabId)
      .then((d: Dyn) => sendResponse({ conversation: (d['recallflow.conv.' + tabId] || {}).conversation || [] }))
      .catch(() => sendResponse({ conversation: [] }));
    return true;
  }
  // 交接包：面板复制「会话标识」时写入；外部 agent 凭标识经 MCP 取回。
  if (msg && msg.type === 'handoff:save') {
    // ⚠ 必须把**完整轨迹**一起转交：面板发来的是**已建好的 record**（里面只有交付用的摘要），
    //   若不带 `trailItems`，`saveHandoff` 只能从摘要重算"全量" ⇒ 独立 key 里存的其实是摘要 ✗
    //   （`trailItems` 最多 MAX_TRAIL_FULL 步、并受 MAX_FULL_TRAIL_BYTES 约束）
    saveHandoff(msg.record || {}, { trailItems: msg.trailItems })
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg && msg.type === 'handoff:get') {
    // 带上 trailFrom / trailTo 时改为分页读取**完整轨迹**（见 getHandoff 的说明）：
    // 记录里只有摘要，完整轨迹在独立 key 里，按区间取才不至于一次灌爆接手方的上下文。
    getHandoff(msg.id, { trailFrom: msg.trailFrom, trailTo: msg.trailTo })
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg && msg.type === 'handoff:list') {
    listHandoffs(msg.limit)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  // 元素拾取（跨域 iframe）：顶层发起 → 广播到所有 frame 进入拾取；任一 frame 命中/取消 → 全体停止。
  if (msg && msg.type === 'pick:start') {
    const tabId = sender.tab && sender.tab.id;
    if (tabId != null) chrome.tabs.sendMessage(tabId, { type: 'kbPickStart' }, () => void chrome.runtime.lastError);
    sendResponse({ ok: true });
    return false;
  }
  if (msg && msg.type === 'pick:result') {
    const tabId = sender.tab && sender.tab.id;
    const list = Array.isArray(msg.pickedList) ? msg.pickedList : msg.picked ? [msg.picked] : [];
    const pageUrl = (sender.tab && sender.tab.url) || '';
    const ts = Date.now();
    if (list.length) {
      try {
        chrome.storage.local.set({
          'recallflow.lastPicked': Object.assign({}, list[0], { tabId, pageUrl, ts }),
          'recallflow.lastPickedList': list.map((p: Dyn) => Object.assign({}, p, { tabId, pageUrl, ts })),
        });
      } catch (e) {}
    }
    if (tabId != null) {
      chrome.tabs.sendMessage(tabId, { type: 'kbPickCancel' }, () => void chrome.runtime.lastError);
      chrome.tabs.sendMessage(tabId, { type: 'kbPickResult', pickedList: list }, { frameId: 0 }, () => void chrome.runtime.lastError);
    }
    sendResponse({ ok: true });
    return false;
  }
  if (msg && msg.type === 'pick:cancel') {
    const tabId = sender.tab && sender.tab.id;
    if (tabId != null) chrome.tabs.sendMessage(tabId, { type: 'kbPickCancel' }, () => void chrome.runtime.lastError);
    sendResponse({ ok: true });
    return false;
  }
  if (msg && msg.type === 'pageCommand') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !tab.id) {
        sendResponse({ ok: false, error: '无活动标签页' });
        return;
      }
      chrome.tabs.sendMessage(tab.id, { type: 'kbPageCommand', command: msg.command, params: msg.params || {} }, { frameId: 0 }, (res) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse(res || { ok: false, error: '页面命令无响应' });
        }
      });
    });
    return true;
  }
  if (msg && msg.type === 'userscript:list') {
    listScripts()
      .then((scripts) => sendResponse({ ok: true, scripts }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg && msg.type === 'userscript:install') {
    installFromUrl(msg.url)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg && msg.type === 'userscript:preview') {
    previewScript(msg.url)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg && msg.type === 'userscript:installCode') {
    installFromCode(msg.code, msg.label)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg && msg.type === 'userscript:previewCode') {
    previewCode(msg.code)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg && msg.type === 'userscript:update') {
    updateScript(msg.id)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg && msg.type === 'userscript:updateAll') {
    updateAllScripts()
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg && msg.type === 'userscript:toggle') {
    setScriptEnabled(msg.id, msg.enabled)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg && msg.type === 'userscript:uninstall') {
    uninstallScript(msg.id)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg && msg.type === 'userscript:search') {
    searchScripts(msg.q)
      .then((list) => sendResponse({ ok: true, list }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg && msg.type === 'userscript:runOnTab') {
    chrome.tabs.query({ currentWindow: true }, (tabs) => {
      // 优先当前激活的普通网页；若当前页是扩展页面（如脚本中心），回退到最近浏览的网页。
      const webTabs = (tabs || []).filter((t) => t.url && isOperableUrl(t.url));
      const tab = webTabs.find((t) => t.active) || webTabs[0];
      if (!tab || !tab.id) {
        sendResponse({ ok: false, error: '没有可运行的网页标签页' });
        return;
      }
      runUserscriptOnTab(tab.id, msg.id)
        .then((r) => sendResponse(r || { ok: false, error: '脚本执行无响应' }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
    });
    return true;
  }
  if (msg && msg.type === 'userscript:xhr') {
    userscriptXhr(msg.details)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg && msg.type === 'userscript:openTab') {
    chrome.tabs.create({ url: msg.url, active: msg.active !== false });
    sendResponse({ ok: true });
    return false;
  }
  if (msg && msg.type === 'userscript:notify') {
    chrome.notifications.create({
      type: 'basic',
      // 通知图标同样只接受位图（与 manifest 的 icons 一个道理）：
      // 指向 .svg 时通知会静默地不出图，而不是报错。
      iconUrl: chrome.runtime.getURL('docs/assets/icon-128.png'),
      title: msg.title || 'RecallFlow',
      message: msg.text || '',
    });
    sendResponse({ ok: true });
    return false;
  }
});

async function requestPersistentHistoryStorage() {
  try {
    if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
  } catch (e) {}
}

// 浏览器启动 / 扩展安装后，重新对齐脚本注册状态。
chrome.runtime.onStartup.addListener(() => {
  requestPersistentHistoryStorage().catch(() => {});
  syncUserscriptRegistrations().catch(() => {});
});
chrome.runtime.onInstalled.addListener(() => {
  requestPersistentHistoryStorage().catch(() => {});
  syncUserscriptRegistrations().catch(() => {});
});

// 标签页关闭时清理其对话持久化数据。
chrome.tabs.onRemoved.addListener((tabId) => {
  runSubscriptions.delete(tabId);
  const runRec = tabRuns.get(tabId);
  if (runRec && runRec.runId) {
    clearRunAbortTimer(runRec.runId);
    runChannels.delete(String(runRec.runId));
  }
  const c = tabControllers.get(tabId);
  if (c) {
    try {
      runStats.aborts += 1;
      c.abort();
    } catch (e) {}
    tabControllers.delete(tabId);
  }
  tabRuns.delete(tabId);
  panelSessions
    .releaseTabLocks(tabId)
    .then(async (r) => {
      if (r && r.released) {
        const state = await panelSessions.list();
        broadcastPanelSessions(state, null);
      }
    })
    .catch(() => {});
  panelSessions
    .removeTabFromUi(tabId)
    .then((r) => {
      if (r && r.changed) broadcastPanelUi(r.ui, null);
    })
    .catch(() => {});
  try {
    chrome.storage.session.remove('recallflow.conv.' + tabId);
  } catch (e) {}
});

// tabId -> AbortController：标签页关闭时中止其进行中的 run。
// 端口断开会 abort（整页刷新 / 停止 / 标签页关闭都会断开端口）：
//   · 整页刷新 → abort 落盘为 interrupted，新面板 query-run 后自动续跑；
//   · 停止 → 面板显式发 {type:'stop'}，先标记不可续跑再 abort；
//   · 标签页关闭 → tabs.onRemoved 兜底 abort。
const tabControllers = new Map<number, RunController>();
// tabId -> 最近一次 run { runId, resumable }：整页刷新后，新面板据此自动续跑（query-run）。
const tabRuns = new Map<number, Dyn>();
// runId -> RunChannel：run 的输出终端。页面刷新只换终端，不结束 run。
const runChannels = new Map<string, RunChannel>();
// runId -> 重连宽限定时器：端口断开后等新面板 reattach；超时才 abort。
const runAbortTimers = new Map<string, ReturnType<typeof setTimeout>>();
const REATTACH_GRACE_MS = 8000;
// 运行生命周期计数（只读诊断；E2E 用它证明刷新走的是 reattach，而不是 abort+续跑）。
const runStats: {
  starts: number;
  reattaches: number;
  aborts: number;
  hubDeltas: number;
  hubErrors?: number;
  lastHubError?: string;
} = { starts: 0, reattaches: 0, aborts: 0, hubDeltas: 0 };
try {
  // 只有 E2E 显式置 `__rfDebugStats=true` 时才暴露数据；生产环境读不到运行统计。
  Object.defineProperty(globalThis, '__rfRunStats', {
    configurable: true,
    get() {
      return (globalThis as unknown as { __rfDebugStats?: boolean }).__rfDebugStats === true ? runStats : undefined;
    },
  });
} catch (e) {}

function clearRunAbortTimer(runId: unknown) {
  const id = String(runId || '');
  const timer = runAbortTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    runAbortTimers.delete(id);
  }
}

/**
 * 端口断开后的宽限：刷新通常会在一秒内 reattach；扩展被更新 / worker 被回收时
 * 不会有新 port，宽限到期再 abort 并落盘 interrupted，走原来的续跑路径。
 */
function scheduleAbortIfNoReattach(runId: unknown, tabId: number | null | undefined) {
  const id = String(runId || '');
  clearRunAbortTimer(id);
  const timer = setTimeout(() => {
    runAbortTimers.delete(id);
    const rec = tabId == null ? null : tabRuns.get(tabId);
    if (!rec || String(rec.runId || '') !== id) return;
    const channel = runChannels.get(id);
    if (channel && channel.isAttached()) return;
    try {
      if (rec.controller && !rec.controller.__rfFinished) {
        runStats.aborts += 1;
        rec.controller.abort();
      }
    } catch (e) {}
  }, REATTACH_GRACE_MS);
  runAbortTimers.set(id, timer);
}

/**
 * 请求停止一个正在运行的 run（owner 页自己点停止，或跟随页远程点停止）。
 * 返回失败时调用方应刷新会话，而不是继续显示「运行中」。
 */
function requestRunStop(params: Dyn, requesterTabId: number | null | undefined) {
  const p = params || {};
  const wantedRunId = String(p.runId || '');
  const wantedSessionId = String(p.sessionId || '');
  let owner: { tabId: number; rec: Dyn } | null = null;
  for (const [tabId, rec] of tabRuns) {
    if (!rec) continue;
    if (wantedRunId && String(rec.runId || '') !== wantedRunId) continue;
    if (!wantedRunId && wantedSessionId && String(rec.sessionId || '') !== wantedSessionId) continue;
    owner = { tabId: Number(tabId), rec };
    break;
  }
  if (!owner && wantedSessionId) {
    const snap = runHub.findBySession(wantedSessionId);
    if (snap && snap.ownerTabId != null) {
      const tabId = Number(snap.ownerTabId);
      owner = { tabId, rec: tabRuns.get(tabId) || {} };
    }
  }
  const runId = String((owner && owner.rec && owner.rec.runId) || wantedRunId);
  const snapshot = runId ? runHub.snapshot(runId) : null;
  if (!snapshot || snapshot.status !== 'running') {
    return { ok: false, code: 'not-running', error: '该任务已结束，无需停止' };
  }
  if (!owner) return { ok: false, code: 'owner-missing', error: '找不到任务所属标签页' };
  const controller = tabControllers.get(owner.tabId);
  if (!controller || controller.signal.aborted) {
    return { ok: false, code: 'already-stopping', error: '该任务已在停止中' };
  }

  if (owner.rec && typeof owner.rec === 'object') {
    tabRuns.set(owner.tabId, Object.assign({}, owner.rec, { resumable: false }));
  }
  clearRunAbortTimer(runId);
  // 先广播「停止中」，再 abort：abort 后的收尾可能很快，不能让跟随页错过中间状态。
  runHub.push(runId, {
    type: 'stop-requested',
    byTabId: requesterTabId == null ? null : Number(requesterTabId),
  });
  try {
    runStats.aborts += 1;
    controller.abort();
  } catch (e) {}

  // runHub 的 delta 本来就不发给 owner（owner 有自己的 port）。跟随页发起停止时，
  // 必须显式通知 owner 收尾，否则 owner 的停止按钮会一直停在「运行中」。
  if (requesterTabId != null && Number(requesterTabId) !== owner.tabId) {
    chrome.tabs.sendMessage(
      owner.tabId,
      {
        type: 'run:stopped',
        runId,
        sessionId: snapshot.sessionId || wantedSessionId,
        remote: true,
      },
      { frameId: 0 },
      () => void chrome.runtime.lastError
    );
  }
  return { ok: true, runId, sessionId: snapshot.sessionId || wantedSessionId, ownerTabId: owner.tabId };
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ai-stream') return;

  const senderTabId = port.sender && port.sender.tab ? port.sender.tab.id : null;
  // 只有真正发起 run 的 port 才需要 controller。query-run / reattach 这类
  // 临时 port 若也建 controller，会在断开时把别人的 run abort 掉。
  let controller: RunController | null = null;
  let attachedRunId = '';
  const ensureController = () => {
    if (!controller) {
      controller = new AbortController() as RunController;
      if (senderTabId) tabControllers.set(senderTabId, controller);
    }
    return controller;
  };
  port.onDisconnect.addListener(() => {
    // 刷新/导航只摘终端，不结束 run；新页面会在宽限内 reattach。
    if (attachedRunId) {
      const channel = runChannels.get(attachedRunId);
      if (channel) channel.detach(port);
      const rec = senderTabId == null ? null : tabRuns.get(senderTabId);
      if (rec && String(rec.runId || '') === attachedRunId) {
        scheduleAbortIfNoReattach(attachedRunId, senderTabId);
        return;
      }
    }
    // 没有绑定 run 的 port（query-run 等）断开不产生副作用；
    // 真正 abort 只留给显式停止、标签页关闭和宽限超时。
    if (controller && !controller.__rfFinished) {
      try {
        runStats.aborts += 1;
        controller.abort();
      } catch (e) {}
    }
  });

  port.onMessage.addListener(async (payload) => {
    let aborted = false;
    try {
      // 停止：面板显式请求中止 run，并标记为不可续跑。
      if (payload && payload.type === 'stop') {
        const tr = senderTabId ? tabRuns.get(senderTabId) : null;
        const stopped = requestRunStop({ runId: tr && tr.runId, sessionId: tr && tr.sessionId }, senderTabId);
        // 已经处于收尾/停止中的 run 仍要 abort 一次兜底，保证端口断开前的意图不丢。
        if (!stopped.ok && controller && !controller.__rfFinished) {
          try {
            runStats.aborts += 1;
            controller.abort();
          } catch (e) {}
        }
        return;
      }
      // 整页刷新后的新面板：查询本 tab 是否有可续跑的 run。
      if (payload && payload.type === 'query-run') {
        const tr = senderTabId ? tabRuns.get(senderTabId) : null;
        const reply = (m: Dyn) => { try { port.postMessage(Object.assign({ type: 'run-state' }, m)); } catch (e) {} };
        if (!tr || !tr.resumable || !tr.runId) {
          reply({ runId: '', resumable: false, live: false, pending: false, instruction: '' });
          return;
        }
        // 端口断开后 run 仍活着：新面板直接 reattach，不启动第二次 agent 请求。
        const liveSnapshot = runHub.snapshot(tr.runId);
        const liveChannel = runChannels.get(String(tr.runId));
        if (liveChannel && liveSnapshot && liveSnapshot.status === 'running') {
          reply({
            runId: String(tr.runId),
            resumable: true,
            live: true,
            pending: false,
            instruction: liveSnapshot.instruction || '',
            snapshot: liveSnapshot,
          });
          return;
        }
        try {
          const s = await loadAgentSession(tr.runId);
          // abort 与落盘是异步的：会话还没写出来时告诉面板"稍后重试"，避免竞态误判"没有任务"。
          if (!s) { reply({ runId: '', resumable: false, live: false, pending: true, instruction: '' }); return; }
          const instruction = String(s.instruction || '');
          const dead = ['completed', 'failed', 'cancelled', 'timeout'].includes(s.status);
          // 把 SW 侧已归约的运行快照一并交给新面板：刷新前已经发生的工具步骤、
          // 叙述与思考都还在这里面。只回 runId 的话，新面板只能从"续跑之后"
          // 开始显示，用户会看到前半轮凭空消失。
          const snapshot = runHub.snapshot(tr.runId);
          reply({
            runId: instruction && !dead ? tr.runId : '',
            resumable: Boolean(instruction) && !dead,
            live: false,
            finished: Boolean(dead || !instruction),
            pending: false,
            instruction,
            snapshot: snapshot || null,
          });
        } catch (e) {
          reply({ runId: '', resumable: false, live: false, pending: false, instruction: '' });
        }
        return;
      }
      // 新页面接管仍然活着的 run：把输出终端从旧 port 切到新 port。
      if (payload && payload.type === 'reattach') {
        const runId = String(payload.runId || '');
        const channel = runId ? runChannels.get(runId) : null;
        const snapshot = runId ? runHub.snapshot(runId) : null;
        const attachFailed = (reason: string) => {
          try {
            port.postMessage({ type: 'reattach-failed', runId, reason, snapshot });
          } catch (e) {}
        };
        if (!runId || !channel || !snapshot || snapshot.status !== 'running') {
          attachFailed(snapshot ? '该任务已结束' : '没有可接管的运行');
          return;
        }
        clearRunAbortTimer(runId);
        attachedRunId = runId;
        runStats.reattaches += 1;
        // 先挂上但暂停发送，再把快照交给新面板，最后放行 attach 之后的事件。
        if (!channel.attach(port, { paused: true })) {
          attachFailed('无法绑定页面连接');
          return;
        }
        try {
          port.postMessage({
            type: 'reattached',
            runId,
            sessionId: snapshot.sessionId,
            snapshot,
          });
        } catch (e) {
          attachFailed('页面连接已断开');
          return;
        }
        channel.resume();
        return;
      }
      // 工具审批消息由 waitForToolApproval 的临时监听器处理，不能作为新的对话请求。
      if (payload && payload.type === 'tool-approval') return;
      // 心跳：保持 service worker 存活（长任务期间），不触发新请求。
      if (payload && payload.type === 'keepalive') return;
      // E2E 专用：从**后台侧**断开当前端口，用于验证面板的断线重连。
      // 为什么必须从后台侧断：实测面板自己调用 port.disconnect() 并不会触发
      // 它自己的 onDisconnect（本端主动断开不走该事件），因此那是**测不到**的路径。
      // 而后台侧断开正是真实场景（MV3 worker 被回收）。
      if (payload && payload.type === 'e2e-drop-port') {
        // 先让本轮 abort 落盘（模拟 worker 被回收），再断开端口。
        try {
          runStats.aborts += 1;
          if (controller) controller.abort();
        } catch (e) {}
        setTimeout(() => {
          try { port.disconnect(); } catch (e) {}
        }, 120);
        return;
      }
      // 断线重连的就绪探针：面板在重连前用它确认「中断的会话已落盘」。
      // 为什么必须有：面板的 onDisconnect 与后台 persist({phase:'interrupted'}) 是并发的。
      // 若重连早于落盘，runAgentStream 的 canResume 为 false，会把重连当成**一次新任务**
      // 从头开始 —— 用户会看到重复执行，且历史里同一条指令出现两次。
      if (payload && payload.type === 'session-ready') {
        let ready = false;
        try {
          ready = Boolean(await loadAgentSession(String(payload.runId || '')));
        } catch (e) {
          ready = false;
        }
        try { port.postMessage({ type: 'session-ready', ready }); } catch (e) {}
        return;
      }
      const settings = await getAISettings();
      if (!settings.apiKey) {
        port.postMessage({ type: 'error', needSetup: true, error: '尚未配置 API Key，请点击插件图标 → 设置页填写。' });
        return;
      }
      const book = await getBook();
      if (payload.action === 'agent') {
        const tabId = port.sender && port.sender.tab && port.sender.tab.id;
        const runId = payload.runId || 'run-' + Date.now().toString(36);
        payload.runId = runId;
        const sessionId = String(payload.sessionId || '');
        // 同一个 run 已经活着：这是刷新后/断线重连的重复请求，不是新任务。
        // 直接接管到现有通道，绝不能并发启动第二个 runAgentStream。
        const liveSnapshot = runHub.snapshot(runId);
        const existingChannel = runChannels.get(String(runId));
        if (existingChannel && liveSnapshot && liveSnapshot.status === 'running') {
          clearRunAbortTimer(runId);
          runStats.reattaches += 1;
          attachedRunId = String(runId);
          if (existingChannel.attach(port, { paused: true })) {
            try {
              port.postMessage({
                type: 'reattached',
                runId,
                sessionId: liveSnapshot.sessionId || sessionId,
                snapshot: liveSnapshot,
              });
            } catch (e) {}
            existingChannel.resume();
          }
          return;
        }
        console.log('[RecallFlow] agent run start:', (payload.question || '').slice(0, 40), 'tabId=' + tabId, 'session=' + sessionId);
        runStats.starts += 1;
        const channel = existingChannel || new RunChannel();
        runChannels.set(String(runId), channel);
        const runController = ensureController();
        if (!channel.attach(port, {})) {
          port.postMessage({ type: 'error', error: '无法绑定 Agent 输出通道。' });
          return;
        }
        attachedRunId = String(runId);
        if (tabId) tabRuns.set(tabId, { runId, resumable: true, sessionId, channel, controller: runController });
        if (sessionId) {
          runHub.begin({
            runId,
            sessionId,
            ownerTabId: tabId,
            instruction: payload.question || payload.text || '',
          });
        }
        try {
          await runAgentStream(
            channel,
            payload,
            settings,
            book,
            runController.signal,
            tabId,
            (event: Dyn) => {
              if (event && event.type === 'tabs-close-pending') registerRunCleanup(runId, event);
              if (sessionId) {
                try {
                  runHub.push(runId, event);
                } catch (e) {
                  runStats.hubErrors = (runStats.hubErrors || 0) + 1;
                  runStats.lastHubError = String((e as Error | null)?.message || e);
                }
              }
            }
          );
          console.log('[RecallFlow] agent run finished');
          // abort 既可能是用户停止，也可能是页面刷新/端口断开；不能一律报 completed。
          if (sessionId) runHub.finish(runId, runController.signal.aborted ? 'cancelled' : 'completed');
          runController.__rfFinished = true;
          clearRunAbortTimer(runId);
          runChannels.delete(String(runId));
          attachedRunId = '';
        } catch (e) {
          const detail = (e as Error | null)?.stack || String(e);
          console.error('[RecallFlow] agent run error:', detail);
          // 把真实错误回传前端，避免只看到「转圈」或笼统报错。
          try { port.postMessage({ type: 'error', error: 'Agent 运行出错：' + ((e as Error | null)?.message || String(e)) }); } catch (err) {}
          try { port.postMessage({ type: 'end' }); } catch (err) {}
          if (sessionId) {
            runHub.push(runId, { type: 'error', error: 'Agent 运行出错：' + ((e as Error | null)?.message || String(e)) });
            runHub.push(runId, { type: 'end' });
            runHub.finish(runId, runController.signal.aborted ? 'cancelled' : 'failed');
          }
          runController.__rfFinished = true;
          clearRunAbortTimer(runId);
          runChannels.delete(String(runId));
          attachedRunId = '';
        }
        return;
      }
      const messages = buildAiMessages(payload.action, payload, settings, book);
      if (!messages) {
        port.postMessage({ type: 'error', error: '未知操作：' + payload.action });
        return;
      }

      // 发送引用来源元数据给前端（在流式响应开始前）
      if (messages._citations && messages._citations.length) {
        port.postMessage({ type: 'citations', citations: messages._citations });
      }

      const url = settings.baseUrl.replace(/\/+$/, '') + '/chat/completions';
      // 出站消毒：内容里只要有一个孤立代理（切裂的代理对），服务端会在**解析请求体**阶段
      // 整单拒收 400（而且 400 不重试）。面板这条闲聊路径同样会带上页面文本，必须过一遍。
      try {
        sanitizeMessages(messages);
      } catch (e) {}
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + settings.apiKey,
        },
        body: JSON.stringify({
          model: settings.model,
          messages,
          temperature: 0.3,
          stream: true,
        }),
        // 非 agent 分支没有 ensureController()，这里保留原有行为（null 时照旧抛错），
        // 类型迁移批不改语义；见交付评论的「已知遗留」。
        signal: controller!.signal,
      });

      if (!resp.ok) {
        let detail = '';
        try {
          const j = await resp.json();
          detail = j.error && j.error.message ? j.error.message : JSON.stringify(j);
        } catch (e) {
          detail = await resp.text();
        }
        port.postMessage({ type: 'error', error: 'DeepSeek 请求失败 (' + resp.status + '): ' + detail });
        return;
      }

      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const json = JSON.parse(data);
            const delta = json.choices && json.choices[0] && json.choices[0].delta;
            if (delta && delta.content) {
              port.postMessage({ type: 'chunk', text: delta.content });
            }
          } catch (e) {
            logError('Failed to parse SSE chunk', { data, error: (e as Error).message });
          }
        }
      }
      if (buffer.trim()) {
        const trimmed = buffer.trim();
        if (trimmed.startsWith('data:')) {
          const data = trimmed.slice(5).trim();
          if (data !== '[DONE]') {
            try {
              const json = JSON.parse(data);
              const delta = json.choices && json.choices[0] && json.choices[0].delta;
              if (delta && delta.content) {
                port.postMessage({ type: 'chunk', text: delta.content });
              }
            } catch (e) {
              logError('Failed to parse final SSE chunk', { data, error: (e as Error).message });
            }
          }
        }
      }
      // ⚠ 原名是未声明的 `aborted`（TS2304）：运行时走到这里必然 ReferenceError，
      // 被下面的 catch 再吞一次。这里按显然的意图取 controller 的 aborted —— 这是本批
      // **唯一**的运行时修复，交付评论单列（类型迁移批原则上不改语义）。
      aborted = Boolean(controller && controller.signal.aborted);
      if (!aborted) port.postMessage({ type: 'end' });
    } catch (e) {
      if (aborted) return;
      port.postMessage({ type: 'error', error: (e as Error).message });
    }
  });
});

// 启动 RecallFlow ↔ opencode 的本地中继（连接本机 MCP server）。
// 未运行 MCP server 时连接失败会自动重试，不影响扩展其它功能。
startMcpRelay();

// 初始化统一 Target 管理：订阅对话框 / 下载 / 文件选择等浏览器级事件。
initTargetManager();
