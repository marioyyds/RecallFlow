// 设置页（API Key/模型/RAG/工具审批/快捷语句/MCP）
import { AI_SETTINGS_KEY, AI_SETTINGS_DEFAULTS, getAISettings } from './lib/shared/settings.js';
import { esc } from './lib/shared/utils.js';
import { getUserscriptSettings, saveUserscriptSettings } from './lib/userscript/settings.js';
import { USERSCRIPTS_KEY } from './lib/userscript/store.js';

const $ = (id) => document.getElementById(id);

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
  syncApprovalPreset();
  const budget = s.agentBudget || {};
  $('budget-tools').value = Number.isInteger(Number(budget.maxToolCalls)) && Number(budget.maxToolCalls) > 0 ? String(budget.maxToolCalls) : '';
  $('budget-turns').value = Number.isInteger(Number(budget.maxModelTurns)) && Number(budget.maxModelTurns) > 0 ? String(budget.maxModelTurns) : '';
  $('quick-prompts').value = (s.quickPrompts || AI_SETTINGS_DEFAULTS.quickPrompts).join('\n');
  renderMcp(s.mcpServers || []);

  const us = await getUserscriptSettings();
  $('us-agent-install').checked = us.agentCanInstall !== false;
  $('us-auto-update').checked = !!us.autoCheckUpdates;
  $('us-run-at').value = us.defaultRunAt || 'document-idle';
  renderUserscriptSummary();
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
      '<button class="mcp-del icon-btn" title="删除">✕</button>';
    row.querySelector('.mcp-del').addEventListener('click', () => {
      list.splice(i, 1);
      renderMcp(list);
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

$('save-btn').addEventListener('click', async () => {
  const settings = {
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
    quickPrompts: $('quick-prompts').value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 12),
    mcpServers: collectMcp(),
    agentBudget: {
      ...(Number.isInteger(Number($('budget-tools').value)) && Number($('budget-tools').value) > 0 ? { maxToolCalls: Math.floor(Number($('budget-tools').value)) } : {}),
      ...(Number.isInteger(Number($('budget-turns').value)) && Number($('budget-turns').value) > 0 ? { maxModelTurns: Math.floor(Number($('budget-turns').value)) } : {}),
    },
  };
  await chrome.storage.local.set({ [AI_SETTINGS_KEY]: settings });
  await saveUserscriptSettings({
    agentCanInstall: $('us-agent-install').checked,
    autoCheckUpdates: $('us-auto-update').checked,
    defaultRunAt: $('us-run-at').value || 'document-idle',
  });
  toast('✓ 已保存', true);
});

$('toggle-key').addEventListener('click', () => {
  const el = $('api-key');
  el.type = el.type === 'password' ? 'text' : 'password';
  $('toggle-key').textContent = el.type === 'password' ? '👁' : '🙈';
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

load();
