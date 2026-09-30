// Service Worker 入口（ES Module）：AI 请求 / Agent 编排 / 页面命令转发的消息监听
import { getBook } from './lib/shared/store.js';
import { getAISettings } from './lib/shared/settings.js';
import { buildAiMessages } from './lib/shared/rag.js';
import { callDeepSeek } from './lib/assistant/llm.js';
import { runAgentStream } from './lib/assistant/agent.js';
import { startMcpRelay, sayToDsh } from './lib/bridge/relay.js';
import { initTargetManager } from './lib/assistant/target-manager.js';
import { logError } from './lib/shared/utils.js';
import { saveHandoff, getHandoff, listHandoffs } from './lib/shared/handoff-store.js';
import { normalizeBinding, bindingKey } from './lib/shared/session-binding.js';
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
} from './lib/userscript/manager.js';

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

async function handleAi(request) {
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

  const answer = await callDeepSeek(settings, messages);
  return { ok: true, answer };
}

// SPA 导航（history.pushState / replaceState）不会重载页面，因此：
//   - 内容脚本收不到任何"页面变了"的信号；
//   - 隔离世界也钩不到页面的 history 对象（那是主世界的对象），
//     而在主世界打补丁属于"修改页面行为"，与 debug-hook 的只读约定相悖。
// chrome.webNavigation.onHistoryStateUpdated 是唯一干净的入口（也是为此新增 webNavigation 权限的原因）。
// 用途：让面板发现自己正在讨论的页面已经换了，而不是静默继续。
if (chrome.webNavigation && chrome.webNavigation.onHistoryStateUpdated) {
  chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    // 只看主框架：子框架导航不改变"这个会话在讨论哪个页面"。
    if (!details || details.frameId !== 0 || details.tabId < 0) return;
    try {
      chrome.tabs.sendMessage(details.tabId, { type: 'rfUrlChanged', url: details.url }, () => void chrome.runtime.lastError);
    } catch (e) {}
  });
}

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
  // 会话绑定：面板点「启动」时写入，按 tab 隔离（与 conv 同样的存储约定）。
  // 内容脚本默认读不到 chrome.storage.local，因此必须经后台代理。
  if (msg && msg.type === 'bind:save') {
    const tabId = sender.tab && sender.tab.id;
    const norm = normalizeBinding(msg.binding);
    // tabId 以 sender 为准（存储键也按 tab 隔离）：面板不需要知道自己的 tabId，
    // 但记录里带上它能让会话自描述，便于 DSH 侧将来按 tab 索引。
    const b = norm && tabId != null ? Object.assign({}, norm, { tabId }) : norm;
    if (tabId != null && b) {
      try {
        chrome.storage.local.set({ [bindingKey(tabId)]: b });
        sendResponse({ ok: true, binding: b });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    } else {
      sendResponse({ ok: false, error: b ? '拿不到标签页 id' : '绑定记录不合法' });
    }
    return false;
  }
  if (msg && msg.type === 'bind:get') {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) {
      sendResponse({ binding: null });
      return false;
    }
    chrome.storage.local
      .get(bindingKey(tabId))
      .then((d) => sendResponse({ binding: normalizeBinding(d[bindingKey(tabId)]) }))
      .catch(() => sendResponse({ binding: null }));
    return true;
  }
  if (msg && msg.type === 'bind:clear') {
    const tabId = sender.tab && sender.tab.id;
    if (tabId != null) {
      try {
        chrome.storage.local.remove(bindingKey(tabId));
      } catch (e) {}
    }
    sendResponse({ ok: true });
    return false;
  }
  if (msg && msg.type === 'conv:save') {
    const tabId = sender.tab && sender.tab.id;
    if (tabId != null && Array.isArray(msg.conversation)) {
      try {
        chrome.storage.local.set({ ['recallflow.conv.' + tabId]: { conversation: msg.conversation, updatedAt: Date.now() } });
      } catch (e) {}
    }
    sendResponse({ ok: true });
    return false;
  }
  // 用户在面板里说的一句话 → 送进 DSH 的这条会话（新架构的输入通道）。
  // 必须经后台转发：内容脚本所在网页不是 127.0.0.1，直连会被同源策略挡住。
  //
  // 只转发 role 为 user 的：面板助手自己的输出不再推过去。
  // 新架构下回复本就来自这条会话，而把助手输出当成用户输入灌进去，
  // 才是真正的"冒充用户消息"。
  if (msg && msg.type === 'panel:turn') {
    if (msg.role !== 'user') {
      sendResponse({ ok: true, rpcId: '' });
      return false;
    }
    const text = String(msg.text || '').slice(0, 4000);
    if (!text) {
      sendResponse({ ok: false, rpcId: '' });
      return false;
    }
    // 异步等待：把插件回传的 rpcId 交给面板，面板才能把"本地那条回合"与
    // 从会话回声回来的那条**精确对齐**（否则只能靠文本猜）。
    // 返回 true 表示"会异步回复" —— Chrome 要求这样保持消息通道。
    sayToDsh(text)
      .then((r) => sendResponse(r))
      .catch(() => sendResponse({ ok: false, rpcId: '' }));
    return true;
  }
  if (msg && msg.type === 'conv:get') {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) {
      sendResponse({ conversation: [] });
      return false;
    }
    chrome.storage.local
      .get('recallflow.conv.' + tabId)
      .then((d) => sendResponse({ conversation: (d['recallflow.conv.' + tabId] || {}).conversation || [] }))
      .catch(() => sendResponse({ conversation: [] }));
    return true;
  }
  // 交接包：面板复制「会话标识」时写入；外部 agent 凭标识经 MCP 取回。
  if (msg && msg.type === 'handoff:save') {
    saveHandoff(msg.record || {})
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg && msg.type === 'handoff:get') {
    getHandoff(msg.id)
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
          'recallflow.lastPickedList': list.map((p) => Object.assign({}, p, { tabId, pageUrl, ts })),
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
      const webTabs = (tabs || []).filter((t) => t.url && /^https?:/i.test(t.url));
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
      iconUrl: chrome.runtime.getURL('docs/assets/recallflow-mark.svg'),
      title: msg.title || 'RecallFlow',
      message: msg.text || '',
    });
    sendResponse({ ok: true });
    return false;
  }
});

// 浏览器启动 / 扩展安装后，重新对齐脚本注册状态。
chrome.runtime.onStartup.addListener(() => {
  syncUserscriptRegistrations().catch(() => {});
});
chrome.runtime.onInstalled.addListener(() => {
  syncUserscriptRegistrations().catch(() => {});
});

// 标签页关闭时清理其对话持久化数据。
chrome.tabs.onRemoved.addListener((tabId) => {
  try {
    chrome.storage.local.remove('recallflow.conv.' + tabId);
  } catch (e) {}
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ai-stream') return;

  const controller = new AbortController();
  let aborted = false;
  port.onDisconnect.addListener(() => {
    aborted = true;
    try {
      controller.abort();
    } catch (e) {
      logError('Abort controller failed', e);
    }
  });

  port.onMessage.addListener(async (payload) => {
    try {
      // 工具审批消息由 waitForToolApproval 的临时监听器处理，不能作为新的对话请求。
      if (payload && payload.type === 'tool-approval') return;
      // 心跳：保持 service worker 存活（长任务期间），不触发新请求。
      if (payload && payload.type === 'keepalive') return;
      const settings = await getAISettings();
      if (!settings.apiKey) {
        port.postMessage({ type: 'error', needSetup: true, error: '尚未配置 API Key，请点击插件图标 → 设置页填写。' });
        return;
      }
      const book = await getBook();
      if (payload.action === 'agent') {
        const tabId = port.sender && port.sender.tab && port.sender.tab.id;
        console.log('[RecallFlow] agent run start:', (payload.question || '').slice(0, 40), 'tabId=' + tabId);
        try {
          await runAgentStream(port, payload, settings, book, controller.signal, tabId);
          console.log('[RecallFlow] agent run finished');
        } catch (e) {
          const detail = e && e.stack ? e.stack : String(e);
          console.error('[RecallFlow] agent run error:', detail);
          // 把真实错误回传前端，避免只看到「转圈」或笼统报错。
          try { port.postMessage({ type: 'error', error: 'Agent 运行出错：' + (e && e.message ? e.message : String(e)) }); } catch (err) {}
          try { port.postMessage({ type: 'end' }); } catch (err) {}
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
        signal: controller.signal,
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

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
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
            logError('Failed to parse SSE chunk', { data, error: e.message });
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
              logError('Failed to parse final SSE chunk', { data, error: e.message });
            }
          }
        }
      }
      if (!aborted) port.postMessage({ type: 'end' });
    } catch (e) {
      if (aborted) return;
      port.postMessage({ type: 'error', error: e.message });
    }
  });
});

// 启动 RecallFlow ↔ opencode 的本地中继（连接本机 MCP server）。
// 未运行 MCP server 时连接失败会自动重试，不影响扩展其它功能。
startMcpRelay();

// 初始化统一 Target 管理：订阅对话框 / 下载 / 文件选择等浏览器级事件。
initTargetManager();
