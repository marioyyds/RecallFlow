// Service Worker 入口（ES Module）：AI 请求 / Agent 编排 / 页面命令转发的消息监听
import { getBook } from '../lib/shared/store.ts';
import { getAISettings } from '../lib/shared/settings.ts';
import { buildAiMessages } from '../lib/shared/rag.ts';
import { callDeepSeek } from '../lib/application/agent/llm.ts';
import { runAgentStream } from '../lib/application/agent/agent.ts';
import { createAgentRunner } from '../lib/application/agent/runner.ts';
import { PanelMessageRouter } from '../lib/application/background/panel-router.ts';
import { AutomationMessageRouter } from '../lib/application/background/automation-router.ts';
import { handleAiStreamConnection } from '../lib/application/background/ai-stream-router.ts';
import { WorkspaceMessageRouter } from '../lib/application/background/workspace-router.ts';
import { startMcpRelay } from '../lib/bridge/relay.ts';
import { initTargetManager } from '../lib/application/agent/target-manager.ts';
import { logError } from '../lib/shared/text.ts';
import { isOperableUrl } from '../lib/shared/url.ts';
import { normalizeHistory } from '../lib/application/agent/context.ts';
import { saveHandoff, getHandoff, listHandoffs } from '../lib/shared/handoff-store.ts';
import { loadAgentSession } from '../lib/application/agent/session-store.ts';
import {
  PanelSessionStore,
  PSESS_INDEX_KEY,
  PSESS_ACTIVE_KEY,
  PSESS_SESSION_PREFIX,
} from '../lib/shared/panel-sessions.ts';
import { RunStreamHub } from '../lib/application/agent/run-hub.ts';
import { RunChannel } from '../lib/application/agent/run-channel.ts';
import { createTabRunRegistry, type RunControllerLike, type RunRecordLike } from '../lib/application/agent/run-registry.ts';
import { RunLifecycleService } from '../lib/application/agent/run-lifecycle.ts';
import { createIndexedDbKeyValueStore } from '../lib/shared/idb-kv.ts';
import { createChromeStorageAdapter } from '../lib/adapters/chrome/storage.ts';
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

const agentRunner = createAgentRunner(runAgentStream);

/** AbortController 上额外挂的运行标记（run 收尾后置 true，防止重复 abort）。 */
type RunController = RunControllerLike;

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
const chromeSessionStorage = createChromeStorageAdapter(chrome.storage.session, chrome);
const chromeLocalStorage = createChromeStorageAdapter(chrome.storage.local, chrome);

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
        chromeSessionStorage.get(null),
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
        Object.assign(out, await chromeSessionStorage.get(parts.persistent));
      }
    }
    if (parts.session.length) Object.assign(out, await chromeSessionStorage.get(parts.session));
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
          await chromeSessionStorage.set(persistent);
        })
      );
    }
    if (Object.keys(session).length) jobs.push(chromeSessionStorage.set(session));
    await Promise.all(jobs);
  },
  async remove(keys: string | string[] | null) {
    const parts = splitPanelKeys(keys);
    const jobs = [];
    if (parts.persistent.length) jobs.push(persistentPanelStorage.remove(parts.persistent).catch(() => {}));
    if (parts.session.length) jobs.push(chromeSessionStorage.remove(parts.session));
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
    const all = (await chromeSessionStorage.get(null)) as Dyn;
    const persistentKeys = Object.keys(all || {}).filter(isPersistentPanelKey);
    if (!persistentKeys.length) return;
    const items: Dyn = {};
    for (const key of persistentKeys) items[key] = all[key];
    await persistentPanelStorage.set(items);
    await chromeSessionStorage.remove(persistentKeys);
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
      const all = (await chromeSessionStorage.get(null)) as Dyn;
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
          await chromeSessionStorage.remove(state.migratedKeys);
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

const panelMessageRouter = new PanelMessageRouter({
  store: panelSessions,
  ensureSessions: ensurePanelSessions,
  broadcastSessions: broadcastPanelSessions,
  broadcastUi: broadcastPanelUi,
  sendToTab(tabId, message) {
    chrome.tabs.sendMessage(tabId, message, { frameId: 0 }, () => void chrome.runtime.lastError);
  },
  removeScreenshots: (sessionId) => removeSessionScreenshots(chrome, sessionId),
});

function chromeCallback<T>(register: (done: (value: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve) => register(resolve));
}

const automationMessageRouter = new AutomationMessageRouter({
  queryTabs(query) {
    return chromeCallback((done) => chrome.tabs.query(query, (tabs) => done(tabs || [])));
  },
  requestTab(tabId, message) {
    return chromeCallback((done) => {
      chrome.tabs.sendMessage(tabId, message, { frameId: 0 }, (response) => {
        done(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : response);
      });
    });
  },
  sendToTab(tabId, message) {
    chrome.tabs.sendMessage(tabId, message, { frameId: 0 }, () => void chrome.runtime.lastError);
  },
  createTab(options) {
    return chromeCallback<void>((done) => chrome.tabs.create(options as chrome.tabs.CreateProperties, () => done()));
  },
  setLocal(items) {
    return chromeLocalStorage.set(items);
  },
  notify(options) {
    return chromeCallback<void>((done) => {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('docs/assets/icon-128.png'),
        title: options.title,
        message: options.text,
      }, () => done());
    });
  },
  isOperableUrl,
  userscripts: {
    list: listScripts,
    install: installFromUrl,
    preview: previewScript,
    installCode: installFromCode,
    previewCode,
    update: updateScript,
    updateAll: updateAllScripts,
    setEnabled: setScriptEnabled,
    uninstall: uninstallScript,
    search: searchScripts,
    runOnTab: runUserscriptOnTab,
    xhr: userscriptXhr,
  },
});

const workspaceMessageRouter = new WorkspaceMessageRouter({
  openOptions() {
    chrome.runtime.openOptionsPage();
  },
  openManager(focusId) {
    chrome.tabs.create({
      url: chrome.runtime.getURL('manager.html') + (focusId ? '#focus=' + encodeURIComponent(focusId) : ''),
    });
  },
  sessionStorage: chromeSessionStorage,
  saveHandoff,
  getHandoff,
  listHandoffs,
});

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
  const messages = buildAiMessages(request.action, request, settings, book, normalizeHistory);
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
  if (msg && workspaceMessageRouter.matches(msg)) {
    workspaceMessageRouter
      .handle(msg, { tabId: sender.tab && sender.tab.id != null ? sender.tab.id : null })
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e && e.message ? e.message : String(e) }));
    return true;
  }
  if (msg && panelMessageRouter.matches(msg)) {
    panelMessageRouter
      .handle(msg, { tabId: sender.tab && sender.tab.id != null ? sender.tab.id : null, url: sender.tab && sender.tab.url })
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e && e.message ? e.message : String(e) }));
    return true;
  }
  const automationReply = msg
    ? automationMessageRouter.handle(msg, {
        tabId: sender.tab && sender.tab.id != null ? sender.tab.id : null,
        url: (sender.tab && sender.tab.url) || '',
      })
    : null;
  if (automationReply) {
    automationReply
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e && e.message ? e.message : String(e) }));
    return true;
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
  runLifecycle.cleanupTab(tabId);
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
    chromeSessionStorage.remove('recallflow.conv.' + tabId);
  } catch (e) {}
});

// controller / 最近 run / 输出通道 / reattach 宽限定时器必须一起维护。
const runRegistry = createTabRunRegistry();
const REATTACH_GRACE_MS = 8000;
const runLifecycle = new RunLifecycleService(runRegistry, runHub, {
  sendToTab(tabId, message) {
    chrome.tabs.sendMessage(tabId, message, { frameId: 0 }, () => void chrome.runtime.lastError);
  },
}, REATTACH_GRACE_MS);
const runStats = runLifecycle.stats;
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
  runLifecycle.clearAbortTimer(runId);
}

/**
 * 端口断开后的宽限：刷新通常会在一秒内 reattach；扩展被更新 / worker 被回收时
 * 不会有新 port，宽限到期再 abort 并落盘 interrupted，走原来的续跑路径。
 */
function scheduleAbortIfNoReattach(runId: unknown, tabId: number | null | undefined) {
  runLifecycle.scheduleAbortIfNoReattach(runId, tabId);
}

/**
 * 请求停止一个正在运行的 run（owner 页自己点停止，或跟随页远程点停止）。
 * 返回失败时调用方应刷新会话，而不是继续显示「运行中」。
 */
function requestRunStop(params: Dyn, requesterTabId: number | null | undefined) {
  return runLifecycle.requestStop(params || {}, requesterTabId);
}

const aiStreamDependencies = {
  runRegistry,
  runHub,
  agentRunner,
  runLifecycle,
  runStats,
  registerRunCleanup,
  clearRunAbortTimer,
  requestRunStop,
  scheduleAbortIfNoReattach,
  loadAgentSession,
  getAISettings,
  getBook,
  buildAiMessages,
  normalizeHistory,
  logError,
};

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ai-stream') return;
  handleAiStreamConnection(port, aiStreamDependencies);
});

// 启动 RecallFlow ↔ opencode 的本地中继（连接本机 MCP server）。
// 未运行 MCP server 时连接失败会自动重试，不影响扩展其它功能。
startMcpRelay();

// 初始化统一 Target 管理：订阅对话框 / 下载 / 文件选择等浏览器级事件。
initTargetManager();
