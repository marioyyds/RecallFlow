// 设置页（API Key/模型/RAG/工具审批/快捷语句/MCP）
import { AI_SETTINGS_KEY, AI_SETTINGS_DEFAULTS, getAISettings, resolveCodeExecutionApproval } from '../lib/shared/settings.js';
import { esc } from '../lib/shared/utils.js';
import { getUserscriptSettings, saveUserscriptSettings } from '../lib/userscript/settings.js';
import { USERSCRIPTS_KEY } from '../lib/userscript/store.js';
// 复用后台那一套握手（initialize → notifications/initialized → tools/list），
// 这样「设置页显示的结果」与「Agent 真正连的结果」是同一份代码，不会各说各话。
import { probeMcpServer, MCP_STATUS_STORAGE_KEY } from '../lib/assistant/mcp.js';

const $ = (id) => document.getElementById(id);
let settingsDirty = false;
let settingsLoading = true;

async function load() {
  const s = await getAISettings();
  $('api-key').value = s.apiKey;
  $('model').value = s.model;
  $('base-url').value = s.baseUrl;
  $('rag-enabled').checked = !!s.ragEnabled;
  $('target-lang').value = s.targetLang;
  $('page-context').checked = s.pageContext !== false;
  $('cdp-enabled').checked = s.cdpEnabled !== false;
  $('site-memory').checked = s.siteMemoryEnabled !== false;
  $('verifier-enabled').checked = s.verifierEnabled !== false;
  $('trusted-sites').value = (s.trustedSites || []).join('\n');
  $('tool-approval').checked = s.toolApproval !== false;
  const policy = Object.assign({ read: true, edit: false, commands: false, browser: false, mcp: false }, s.toolApprovalPolicy || {});
  ['read', 'edit', 'commands', 'browser', 'mcp'].forEach((k) => { $('approval-' + k).checked = !!policy[k]; });
  $('approval-notify').checked = s.toolApprovalNotify !== false;
  $('code-exec-approval').value = resolveCodeExecutionApproval(s);
  // 桥接 token：回填真实值，便于用户与 server 端环境变量核对/修改。
  $('bridge-token').value = s.bridgeToken || '';
  syncApprovalPreset();
  const budget = s.agentBudget || {};
  // 工具调用次数与推理轮数上限已移除（对齐 DSH：不限制做了多少件事），
  // 因此那两个输入框不再存在 —— 留一个没人读的设置就是"静默无效"。
  $('budget-tokens').value = Number.isInteger(Number(budget.maxTotalTokens)) && Number(budget.maxTotalTokens) > 0 ? String(budget.maxTotalTokens) : '';
  $('quick-prompts').value = (s.quickPrompts || AI_SETTINGS_DEFAULTS.quickPrompts).join('\n');
  await loadMcpStatus();
  renderMcp(s.mcpServers || []);

  const us = await getUserscriptSettings();
  $('us-agent-install').checked = us.agentCanInstall !== false;
  $('us-auto-update').checked = !!us.autoCheckUpdates;
  $('us-run-at').value = us.defaultRunAt || 'document-idle';
  renderUserscriptSummary();
  settingsLoading = false;
  setDirty(false);
  initSettingsNav();
}

async function renderUserscriptSummary() {
  const meta = $('us-summary-meta');
  const navCount = $('us-nav-count');
  if (!meta && !navCount) return;
  try {
    const data = await chrome.storage.local.get(USERSCRIPTS_KEY);
    const map = data[USERSCRIPTS_KEY] || {};
    const list = Object.values(map);
    const enabled = list.filter((s) => s.enabled).length;
    if (meta) meta.textContent = `已安装 ${list.length} 个 · 启用 ${enabled} 个 · 停用 ${list.length - enabled} 个`;
    if (navCount) {
      navCount.textContent = list.length;
      navCount.classList.toggle('hidden', list.length === 0);
    }
  } catch (e) {
    if (meta) meta.textContent = '已安装 0 个 · 启用 0 个';
  }
}

// 最近一次连接结果（由后台 Agent 运行或本页「测试」写入），按 url|id 索引。
let mcpLastStatus = new Map();

function mcpKeyOf(s) {
  return (s && (s.url || '') + '|' + (s.id || '')) || '';
}

async function loadMcpStatus() {
  try {
    const data = await chrome.storage.local.get(MCP_STATUS_STORAGE_KEY);
    const rec = data && data[MCP_STATUS_STORAGE_KEY];
    mcpLastStatus = new Map(((rec && rec.servers) || []).map((st) => [mcpKeyOf(st), st]));
  } catch (e) {
    mcpLastStatus = new Map();
  }
}

async function saveMcpStatus(st) {
  try {
    const data = await chrome.storage.local.get(MCP_STATUS_STORAGE_KEY);
    const rec = (data && data[MCP_STATUS_STORAGE_KEY]) || { ts: 0, servers: [] };
    const servers = ((rec && rec.servers) || []).filter((x) => mcpKeyOf(x) !== mcpKeyOf(st));
    servers.push(st);
    await chrome.storage.local.set({ [MCP_STATUS_STORAGE_KEY]: { ts: Date.now(), servers } });
  } catch (e) {
    /* 展示用，失败不影响设置本身 */
  }
}

// 失败要给出能动手的指引，而不是一句「连接失败」：MCP 端点没有登录页，
// 403 绝大多数就是 token 没填或与服务端不一致。
function setMcpStatusEl(el, st) {
  if (!st) {
    el.className = 'mcp-status';
    el.textContent = '尚未连接过（点「测试」，或跑一次对话后这里会显示结果）';
    return;
  }
  if (st.ok) {
    el.className = 'mcp-status ok';
    el.textContent = '✓ 已连接：' + st.toolCount + ' 个工具' + (st.ms ? '（' + st.ms + 'ms）' : '');
    return;
  }
  el.className = 'mcp-status bad';
  el.textContent =
    '✗ 连接失败' + (st.status ? '（HTTP ' + st.status + '）' : '') + '：' + (st.error || '未知原因') +
    '。请检查地址是否可达，以及 Bearer Token 是否与服务端一致；MCP 端点用浏览器打开只会得到 401/403，它不是登录页。';
}

function renderMcp(list) {
  const box = $('mcp-list');
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<p class="mcp-empty">尚未配置 MCP 服务器</p>';
    return;
  }
  list.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'mcp-row';
    row.innerHTML =
      '<input class="mcp-id" placeholder="标识(英文)" value="' + esc(s.id || '') + '">' +
      '<input class="mcp-url" placeholder="https://host/mcp" value="' + esc(s.url || '') + '">' +
      '<input class="mcp-token" placeholder="Bearer Token(可选)" value="' + esc((s.headers && s.headers.Authorization || '').replace(/^Bearer\s*/i, '')) + '">' +
      '<button class="mcp-test icon-btn" type="button" title="测试这台服务器能否连通">测试</button>' +
      '<button class="mcp-del icon-btn" title="删除">✕</button>';
    const statusEl = document.createElement('div');
    setMcpStatusEl(statusEl, mcpLastStatus.get(mcpKeyOf(s)));
    row.appendChild(statusEl);
    row.querySelector('.mcp-del').addEventListener('click', () => {
      list.splice(i, 1);
      renderMcp(list);
      markDirty();
    });
    row.querySelector('.mcp-test').addEventListener('click', async () => {
      // 直接读这一行的当前输入（而不是 collectMcp()[i]）：collectMcp 会跳过
      // 没填 id/url 的行，下标与行号并不一致，取错行会让「测 A 得到 B 的结果」。
      const cfg = { id: row.querySelector('.mcp-id').value.trim(), url: row.querySelector('.mcp-url').value.trim() };
      const token = row.querySelector('.mcp-token').value.trim();
      if (token) cfg.headers = { Authorization: 'Bearer ' + token };
      statusEl.className = 'mcp-status';
      statusEl.textContent = '连接中…';
      const st = await probeMcpServer(cfg);
      mcpLastStatus.set(mcpKeyOf(cfg), st);
      setMcpStatusEl(statusEl, st);
      await saveMcpStatus(st);
    });
    box.appendChild(row);
  });
}

function toast(msg, ok) {
  const st = $('status');
  st.textContent = msg;
  st.className = 'status' + (ok ? ' ok' : '');
  clearTimeout(st._t);
  st._t = setTimeout(() => {
    st.textContent = '';
    st.className = 'status';
  }, 1800);
}

function setDirty(dirty) {
  settingsDirty = Boolean(dirty);
  const state = $('save-state');
  if (!state) return;
  state.textContent = settingsDirty ? '有未保存修改' : '已保存';
  state.classList.toggle('dirty', settingsDirty);
}

function markDirty() {
  if (settingsLoading) return;
  setDirty(true);
}

function collectSettings() {
  return {
    apiKey: $('api-key').value.trim(),
    model: $('model').value.trim() || AI_SETTINGS_DEFAULTS.model,
    baseUrl: $('base-url').value.trim().replace(/\/+$/, '') || AI_SETTINGS_DEFAULTS.baseUrl,
    ragEnabled: $('rag-enabled').checked,
    targetLang: $('target-lang').value.trim() || AI_SETTINGS_DEFAULTS.targetLang,
    pageContext: $('page-context').checked,
    cdpEnabled: $('cdp-enabled').checked,
    siteMemoryEnabled: $('site-memory').checked,
    verifierEnabled: $('verifier-enabled').checked,
    trustedSites: $('trusted-sites').value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
    toolApproval: $('tool-approval').checked,
    toolApprovalPolicy: Object.fromEntries(['read', 'edit', 'commands', 'browser', 'mcp'].map((k) => [k, $('approval-' + k).checked])),
    toolApprovalNotify: $('approval-notify').checked,
    codeExecutionApproval: $('code-exec-approval').value || 'session',
    bridgeToken: $('bridge-token').value.trim(),
    quickPrompts: $('quick-prompts').value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 12),
    mcpServers: collectMcp(),
    agentBudget: {
      ...(Number.isInteger(Number($('budget-tokens').value)) && Number($('budget-tokens').value) > 0 ? { maxTotalTokens: Math.floor(Number($('budget-tokens').value)) } : {}),
    },
  };
}

async function saveSettings() {
  const settings = collectSettings();
  await chrome.storage.local.set({ [AI_SETTINGS_KEY]: settings });
  await saveUserscriptSettings({
    agentCanInstall: $('us-agent-install').checked,
    autoCheckUpdates: $('us-auto-update').checked,
    defaultRunAt: $('us-run-at').value || 'document-idle',
  });
  setDirty(false);
  toast('✓ 已保存', true);
}

$('save-btn').addEventListener('click', () => {
  saveSettings().catch((err) => toast('保存失败：' + (err && err.message ? err.message : '未知错误')));
});

document.querySelector('.settings-content').addEventListener('input', markDirty);
document.querySelector('.settings-content').addEventListener('change', markDirty);

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveSettings().catch((err) => toast('保存失败：' + (err && err.message ? err.message : '未知错误')));
  }
});

window.addEventListener('beforeunload', (e) => {
  if (!settingsDirty) return;
  e.preventDefault();
  e.returnValue = '';
});

$('toggle-key').addEventListener('click', () => {
  const el = $('api-key');
  el.type = el.type === 'password' ? 'text' : 'password';
  $('toggle-key').textContent = el.type === 'password' ? '👁' : '🙈';
  $('toggle-key').setAttribute('aria-label', el.type === 'password' ? '显示 API Key' : '隐藏 API Key');
  $('toggle-key').setAttribute('aria-pressed', el.type === 'text' ? 'true' : 'false');
});

function collectMcp() {
  const rows = document.querySelectorAll('#mcp-list .mcp-row');
  const out = [];
  rows.forEach((r) => {
    const id = r.querySelector('.mcp-id').value.trim();
    const url = r.querySelector('.mcp-url').value.trim();
    const token = r.querySelector('.mcp-token').value.trim();
    if (!id || !url) return;
    const srv = { id, url };
    if (token) srv.headers = { Authorization: 'Bearer ' + token };
    out.push(srv);
  });
  return out;
}

$('mcp-add').addEventListener('click', () => {
  const list = collectMcp();
  list.push({ id: '', url: '', headers: {} });
  renderMcp(list);
  markDirty();
});

function syncApprovalPreset() {
  const keys = ['read', 'edit', 'commands', 'browser', 'mcp'];
  const values = keys.map((k) => $('approval-' + k).checked);
  $('approval-preset').value = values.every(Boolean) ? 'all' : values[0] && values.slice(1).every((v) => !v) ? 'safe' : 'custom';
}
$('approval-preset').addEventListener('change', (e) => {
  if (e.target.value === 'safe' || e.target.value === 'all') {
    const on = e.target.value === 'all';
    ['read', 'edit', 'commands', 'browser', 'mcp'].forEach((k) => { $('approval-' + k).checked = on || k === 'read'; });
  }
});
document.querySelectorAll('.approval-list input').forEach((el) => el.addEventListener('change', syncApprovalPreset));

$('test-connection').addEventListener('click', async () => {
  const status = $('connection-status');
  const apiKey = $('api-key').value.trim();
  const baseUrl = $('base-url').value.trim().replace(/\/+$/, '') || AI_SETTINGS_DEFAULTS.baseUrl;
  status.className = 'connection-status';
  if (!apiKey) {
    status.textContent = '请先填写 API Key';
    status.classList.add('error');
    $('api-key').focus();
    return;
  }
  status.textContent = '正在测试…';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(baseUrl + '/models', {
      headers: { Authorization: 'Bearer ' + apiKey },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    status.textContent = '连接成功';
    status.classList.add('ok');
  } catch (err) {
    status.textContent = err && err.name === 'AbortError'
      ? '连接超时'
      : '连接失败：' + (err && err.message ? err.message : '未知错误');
    status.classList.add('error');
  } finally {
    clearTimeout(timer);
  }
});

function initSettingsNav() {
  const links = [...document.querySelectorAll('.settings-sidebar a')];
  const sections = links
    .map((link) => ({ link, section: document.querySelector(link.getAttribute('href')) }))
    .filter((item) => item.section);
  if (!sections.length || typeof IntersectionObserver !== 'function') return;
  if (links[0]) links[0].classList.add('active');
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (!visible.length) return;
      const current = sections.find((item) => item.section === visible[0].target);
      if (!current) return;
      links.forEach((link) => link.classList.toggle('active', link === current.link));
    },
    { rootMargin: '-140px 0px -60% 0px', threshold: [0, 1] }
  );
  sections.forEach((item) => observer.observe(item.section));
}

load();
