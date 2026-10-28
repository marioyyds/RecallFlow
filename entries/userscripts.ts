// 脚本中心：已安装脚本管理（启停/更新/运行/导出/卸载）+ 发现安装（GreasyFork 搜索 / 链接 / 代码）
import { esc } from '../lib/shared/dom/html.ts';
import { showToast } from '../lib/shared/dom/toast.ts';
import { getUserscriptSettings } from '../lib/userscript/settings.ts';

/**
 * 脚本条目 / 后台回包：形状由 lib/userscript/* 与 background 的消息处理器决定。
 * 本页是 DOM 胶水层，字段集合随脚本格式演进 —— 不在这里复制 schema。
 */
type Dyn = Record<string, any>;

/** 按 id 取元素：id 全部写死在 userscripts.html 里（取不到就是模板坏了，原代码也不检查）。 */
const $ = (id: string): any => document.getElementById(id);

/** 事件目标 → 最近的匹配元素（原代码直接 closestEl(e.target, ...)）。 */
const closestEl = (target: EventTarget | null, selector: string): any =>
  target ? (target as Element).closest(selector) : null;

let scriptsCache: Dyn[] = [];
let currentFilter = 'all';
let listQuery = '';
let pendingInstall: { type: string; source: string } | null = null;
let confirmResolve: ((value: boolean) => void) | null = null;
let updatingAll = false;
let lastFocus: HTMLElement | null = null;

function send(type: string, payload?: Dyn): Promise<Dyn> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (res) =>
      resolve(res || { ok: false, error: chrome.runtime.lastError ? chrome.runtime.lastError.message : '无响应' })
    );
  });
}

function toast(msg: string) {
  showToast(msg, { duration: 4000 });
}

/* ---------- 视图切换 ---------- */
function switchView(view: string) {
  document.querySelectorAll('.us-tab').forEach((tab) => {
    const on = (tab as HTMLElement).dataset.view === view;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-selected', String(on));
  });
  $('us-view-installed').classList.toggle('hidden', view !== 'installed');
  $('us-view-discover').classList.toggle('hidden', view !== 'discover');
  if (view === 'discover') setTimeout(() => $('us-search-input').focus(), 60);
}

/* ---------- 已安装列表 ---------- */
function scriptIconHtml(s: Dyn): string {
  const letter = String(s.name || '?').trim().charAt(0).toUpperCase() || '?';
  const icon = s.icon ? `background-image:url("${esc(s.icon)}")` : '';
  return `<span class="us-card-icon${icon ? ' has-img' : ''}" style="${icon}" aria-hidden="true">${icon ? '' : esc(letter)}</span>`;
}

function matchesHtml(matches: unknown): string {
  const list = (matches || []) as string[];
  if (!list.length) return '';
  const shown = list.slice(0, 3);
  const more = list.slice(3);
  return `<div class="us-tags">${shown.map((m) => `<span class="us-tag">${esc(m)}</span>`).join('')}${
    more.length ? `<button class="us-tag us-tag-more" type="button" data-expand="1">＋${more.length} 更多</button>` : ''
  }</div>`;
}

function installedCardHtml(s: Dyn): string {
  const warns = s.warnings || [];
  return `
  <div class="us-card${s.enabled ? '' : ' disabled'}" data-id="${esc(s.id)}">
    <div class="us-card-head">
      ${scriptIconHtml(s)}
      <div class="us-card-main">
        <div class="us-card-name-row">
          ${s.homepageURL
            ? `<a class="us-card-name" href="${esc(s.homepageURL)}" target="_blank" rel="noreferrer" title="打开脚本主页">${esc(s.name)}</a>`
            : `<span class="us-card-name">${esc(s.name)}</span>`}
          <span class="us-card-version">v${esc(s.version)}</span>
          ${s.author ? `<span class="us-card-author">by ${esc(s.author)}</span>` : ''}
        </div>
        ${s.description ? `<div class="us-card-desc">${esc(s.description)}</div>` : ''}
        ${matchesHtml(s.matches)}
        ${warns.length ? `<div class="us-warning">⚠ ${esc(warns.join('\n'))}</div>` : ''}
      </div>
      <label class="us-switch" title="${s.enabled ? '停用该脚本' : '启用该脚本'}">
        <input type="checkbox" data-act="toggle" ${s.enabled ? 'checked' : ''} aria-label="${esc(s.enabled ? '停用' : '启用')} ${esc(s.name)}">
        <span class="us-switch-track" aria-hidden="true"></span>
      </label>
    </div>
    <div class="us-card-actions">
      <button class="mini primary" data-act="run" type="button" title="在最近浏览的网页上立即运行（不要求 URL 匹配）">▶ 运行</button>
      <button class="mini" data-act="update" type="button">↻ 更新</button>
      <button class="mini" data-act="export" type="button">⬇ 导出</button>
      <details class="us-more">
        <summary class="mini" aria-label="更多操作">⋯</summary>
        <div class="us-more-panel">
          <button data-act="copy-url" type="button">复制安装链接</button>
          ${s.homepageURL ? '<button data-act="open-home" type="button">打开脚本主页</button>' : ''}
          <button data-act="uninstall" type="button" class="danger">卸载脚本</button>
        </div>
      </details>
    </div>
  </div>`;
}

function emptyStateHtml(scriptsLen: number, filtered: boolean) {
  if (!scriptsLen) {
    return {
      title: '还没有安装脚本',
      hint: '从 GreasyFork 搜索，或粘贴 .user.js 链接安装',
      cta: true,
    };
  }
  if (filtered) {
    return {
      title: '没有匹配的脚本',
      hint: '试试更换筛选条件或关键词',
      cta: false,
    };
  }
  return { title: '还没有脚本', hint: '安装的脚本会出现在这里', cta: true };
}

function renderInstalled() {
  const total = scriptsCache.length;
  const enabled = scriptsCache.filter((s) => s.enabled).length;
  $('us-stat-all').textContent = String(total);
  $('us-stat-enabled').textContent = String(enabled);
  $('us-stat-disabled').textContent = String(total - enabled);
  $('us-tab-installed-count').textContent = String(total);
  const navCount = $('us-nav-count');
  if (navCount) {
    navCount.textContent = String(total);
    navCount.classList.toggle('hidden', total === 0);
  }

  let list = scriptsCache;
  if (currentFilter === 'enabled') list = list.filter((s) => s.enabled);
  if (currentFilter === 'disabled') list = list.filter((s) => !s.enabled);
  const q = listQuery.trim().toLowerCase();
  if (q) {
    list = list.filter((s) =>
      `${s.name} ${s.description || ''} ${s.author || ''} ${(s.matches || []).join(' ')}`.toLowerCase().includes(q)
    );
  }

  const filtered = list.length !== total;
  const empty = emptyStateHtml(total, filtered);
  $('us-empty').classList.toggle('hidden', list.length > 0);
  const emptyEl = $('us-empty');
  emptyEl.querySelector('p').textContent = empty.title;
  emptyEl.querySelector('.empty-hint').textContent = empty.hint;
  $('us-empty-discover').classList.toggle('hidden', !empty.cta);
  $('us-installed-list').innerHTML = list.map(installedCardHtml).join('');
}

async function refreshInstalled() {
  const res = await send('userscript:list');
  if (!res.ok) {
    toast(res.error || '加载脚本列表失败');
    return;
  }
  scriptsCache = res.scripts || [];
  renderInstalled();
}

function findScript(id: unknown): Dyn | undefined {
  return scriptsCache.find((s) => s.id === id);
}

/* ---------- 全部更新 ---------- */
async function updateAll() {
  if (updatingAll) return;
  if (!scriptsCache.length) {
    toast('还没有已安装的脚本');
    return;
  }
  updatingAll = true;
  const btn = $('us-update-all-btn');
  const progress = $('us-update-progress');
  btn.disabled = true;
  progress.classList.remove('hidden');
  progress.innerHTML = '<span class="us-spinner" aria-hidden="true"></span><span>正在检查更新…</span>';
  try {
    const res = await send('userscript:updateAll');
    if (!res.ok) {
      toast(res.error || '检查更新失败');
    } else if (res.total === 0) {
      toast('没有已安装的脚本');
    } else {
      toast(`更新完成：${res.updated} 个已更新${res.failed ? `，${res.failed} 个失败` : ''}`);
      if (res.failed && res.errors && res.errors.length) {
        console.warn('[RecallFlow] 更新失败：', res.errors);
      }
    }
  } finally {
    updatingAll = false;
    btn.disabled = false;
    progress.classList.add('hidden');
    await refreshInstalled();
  }
}

/* ---------- 导出 / 复制 ---------- */
async function exportScript(id: unknown) {
  const s = findScript(id);
  if (!s || !s.code) {
    toast('该脚本没有可导出的代码');
    return;
  }
  const blob = new Blob([s.code], { type: 'text/javascript;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = String(s.name || 'script').replace(/[\\/:*?"<>|]/g, '_') + '.user.js';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  toast('已导出脚本文件');
}

async function copyInstallUrl(id: unknown) {
  const s = findScript(id);
  if (!s) return;
  const url = s.sourceUrl || s.updateURL;
  if (!url) {
    toast('该脚本没有可复制的安装链接');
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('安装链接已复制');
  } catch (e) {
    toast('复制失败，请手动复制');
  }
}

/* ---------- 发现：搜索 ---------- */
async function runSearch() {
  const q = $('us-search-input').value.trim();
  if (!q) return;
  const status = $('us-search-status');
  const listEl = $('us-search-list');
  $('us-results-title').textContent = `“${q}” 的搜索结果`;
  $('us-search-results').classList.remove('hidden');
  status.textContent = '搜索中…';
  listEl.innerHTML = '';
  const btn = $('us-search-btn');
  btn.disabled = true;
  try {
    const res = await send('userscript:search', { q });
    if (!res.ok) {
      status.textContent = '';
      toast(res.error || '搜索失败');
      return;
    }
    const list = res.list || [];
    status.textContent = list.length ? `找到 ${list.length} 个脚本` : '没有找到相关脚本，试试其他关键词';
    listEl.innerHTML = list.map(searchCardHtml).join('');
  } catch (e) {
    status.textContent = '';
    toast('搜索失败：' + (e as Error).message);
  } finally {
    btn.disabled = false;
  }
}

function searchCardHtml(it: Dyn): string {
  const updated = it.updatedAt ? new Date(it.updatedAt) : null;
  const updatedText = updated && !Number.isNaN(updated.getTime()) ? '更新于 ' + updated.toLocaleDateString('zh-CN') : '';
  return `
  <div class="us-card">
    <div class="us-card-head">
      <span class="us-card-icon" aria-hidden="true">${esc(String(it.name).trim().charAt(0).toUpperCase() || '?')}</span>
      <div class="us-card-main">
        <div class="us-card-name-row">
          <span class="us-card-name">${esc(it.name)}</span>
          ${it.installs ? `<span class="us-card-version">${Number(it.installs).toLocaleString()} 次安装</span>` : ''}
          ${updatedText ? `<span class="us-card-version">${esc(updatedText)}</span>` : ''}
        </div>
        ${it.description ? `<div class="us-card-desc">${esc(it.description)}</div>` : ''}
      </div>
    </div>
    <div class="us-card-actions">
      <button class="mini primary" data-url="${esc(it.codeUrl)}" type="button">安装</button>
      ${it.pageUrl ? `<a class="mini" href="${esc(it.pageUrl)}" target="_blank" rel="noreferrer">查看详情 ↗</a>` : ''}
    </div>
  </div>`;
}

/* ---------- 安装：预览与确认 ---------- */
async function requestInstall(sourceUrl: string) {
  const res = await send('userscript:preview', { url: sourceUrl });
  if (!res.ok || !res.preview) {
    toast(res.error || '无法解析该脚本');
    return;
  }
  pendingInstall = { type: 'url', source: sourceUrl };
  showPreview(res.preview);
}

async function requestInstallCode(code: string) {
  const res = await send('userscript:previewCode', { code });
  if (!res.ok || !res.preview) {
    toast(res.error || '无法解析该脚本');
    return;
  }
  pendingInstall = { type: 'code', source: code };
  showPreview(res.preview);
}

function previewHtml(p: Dyn): string {
  const matches = p.matches || [];
  const grants = p.grants || [];
  const requires = p.requires || [];
  const warns = p.warnings || [];
  return `
    ${matches.length ? `<div class="us-preview-section">访问的网站</div><div class="us-tags">${matches.map((m: string) => `<span class="us-tag">${esc(m)}</span>`).join('')}</div>` : ''}
    ${grants.length ? `<div class="us-preview-section">申请的 GM API</div><div class="us-tags">${grants.map((g: string) => `<span class="us-tag">${esc(g)}</span>`).join('')}</div>` : ''}
    ${requires.length ? `<div class="us-preview-section">外部依赖</div><div class="us-tags">${requires.map((r: string) => `<span class="us-tag">${esc(r)}</span>`).join('')}</div>` : ''}
    ${warns.length ? `<div class="us-warning">⚠ ${esc(warns.join('\n'))}</div>` : ''}
    <div class="us-preview-risk">脚本可以访问它匹配页面上的<b>所有内容</b>，请确认来源可信后再安装。</div>`;
}

function showPreview(p: Dyn) {
  const iconEl = $('us-preview-icon');
  iconEl.className = 'us-card-icon' + (p.icon ? ' has-img' : '');
  iconEl.style.backgroundImage = p.icon ? `url("${esc(p.icon)}")` : '';
  iconEl.textContent = p.icon ? '' : esc(String(p.name || '?').charAt(0).toUpperCase() || '?');
  $('us-preview-name').textContent = p.name + (p.version ? ' · v' + p.version : '');
  $('us-preview-meta').textContent = [p.author, p.homepageURL].filter(Boolean).join(' · ');
  $('us-preview-body').innerHTML = previewHtml(p);
  lastFocus = document.activeElement as HTMLElement | null;
  $('us-preview-overlay').classList.remove('hidden');
  $('us-preview-yes').focus();
}

function closePreview() {
  $('us-preview-overlay').classList.add('hidden');
  pendingInstall = null;
  if (lastFocus && lastFocus.focus) { lastFocus.focus(); lastFocus = null; }
}

/* ---------- 通用确认弹窗 ---------- */
function openConfirm(message: string, yesText?: string): Promise<boolean> {
  $('us-confirm-msg').textContent = message;
  $('us-confirm-yes').textContent = yesText || '确认';
  lastFocus = document.activeElement as HTMLElement | null;
  $('us-confirm-overlay').classList.remove('hidden');
  $('us-confirm-yes').focus();
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}

function closeConfirm(result: boolean) {
  $('us-confirm-overlay').classList.add('hidden');
  if (confirmResolve) {
    confirmResolve(result);
    confirmResolve = null;
  }
  if (lastFocus && lastFocus.focus) { lastFocus.focus(); lastFocus = null; }
}

/* ---------- 事件绑定 ---------- */
document.querySelectorAll('.us-tab').forEach((tab) => {
  tab.addEventListener('click', () => switchView((tab as HTMLElement).dataset.view as string));
});

$('us-empty-discover').addEventListener('click', () => switchView('discover'));

document.querySelectorAll('.us-stat').forEach((stat) => {
  stat.addEventListener('click', () => {
    currentFilter = (stat as HTMLElement).dataset.filter as string;
    document.querySelectorAll('.us-stat').forEach((x) => {
      const on = x === stat;
      x.classList.toggle('active', on);
      x.setAttribute('aria-pressed', String(on));
    });
    renderInstalled();
  });
});

$('us-filter-input').addEventListener('input', (e: Event) => {
  listQuery = (e.target as HTMLInputElement).value;
  renderInstalled();
});

$('us-installed-list').addEventListener('click', async (e: Event) => {
  const card = closestEl(e.target, '.us-card');
  if (!card) return;
  const id = card.dataset.id;

  const expandBtn = closestEl(e.target, '[data-expand]');
  if (expandBtn) {
    const s = findScript(id);
    const tags = card.querySelector('.us-tags');
    if (s && tags) {
      tags.innerHTML = (s.matches || []).map((m: string) => `<span class="us-tag">${esc(m)}</span>`).join('');
    }
    return;
  }

  const act = closestEl(e.target, '[data-act]');
  if (!act) return;
  const action = act.dataset.act;

  if (action === 'update') {
    act.disabled = true;
    const res = await send('userscript:update', { id });
    act.disabled = false;
    toast(res.ok ? '已更新到最新版本' : (res.error || '更新失败'));
    refreshInstalled();
    return;
  }
  if (action === 'run') {
    act.disabled = true;
    const res = await send('userscript:runOnTab', { id });
    act.disabled = false;
    if (res.ok) toast(res.result || '脚本已运行');
    else toast(res.error || '运行失败');
    return;
  }
  if (action === 'export') {
    exportScript(id);
    return;
  }
  if (action === 'copy-url') {
    copyInstallUrl(id);
    card.querySelector('.us-more').removeAttribute('open');
    return;
  }
  if (action === 'open-home') {
    const s = findScript(id);
    if (s && s.homepageURL) {
      card.querySelector('.us-more').removeAttribute('open');
      chrome.tabs.create({ url: s.homepageURL });
    }
    return;
  }
  if (action === 'uninstall') {
    const s = findScript(id);
    card.querySelector('.us-more').removeAttribute('open');
    const ok = await openConfirm(`确定卸载脚本“${s ? s.name : id}”？卸载后其本地存储的数据也会一并删除。`, '卸载');
    if (!ok) return;
    const res = await send('userscript:uninstall', { id });
    if (!res.ok) toast(res.error || '卸载失败');
    else toast('已卸载');
    refreshInstalled();
    return;
  }
});

$('us-installed-list').addEventListener('change', async (e: Event) => {
  const input = closestEl(e.target, 'input[data-act="toggle"]');
  if (!input) return;
  const card = input.closest('.us-card');
  if (!card) return;
  const id = card.dataset.id;
  const res = await send('userscript:toggle', { id, enabled: input.checked });
  if (!res.ok) {
    toast(res.error || '切换失败');
  } else {
    const s = findScript(id);
    if (s) s.enabled = input.checked;
  }
  renderInstalled();
});

$('us-update-all-btn').addEventListener('click', updateAll);

$('us-search-btn').addEventListener('click', runSearch);
$('us-search-input').addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') runSearch();
});

$('us-url-install-btn').addEventListener('click', () => {
  const url = $('us-url-input').value.trim();
  if (!/^https?:\/\//i.test(url)) {
    toast('请输入有效的脚本链接');
    $('us-url-input').focus();
    return;
  }
  requestInstall(url);
});

$('us-code-install-btn').addEventListener('click', () => {
  const code = $('us-code-input').value.trim();
  if (!code) {
    toast('请先粘贴脚本代码');
    $('us-code-input').focus();
    return;
  }
  requestInstallCode(code);
});

$('us-search-list').addEventListener('click', (e: Event) => {
  const btn = closestEl(e.target, '[data-url]');
  if (btn) requestInstall(btn.dataset.url);
});

$('us-preview-yes').addEventListener('click', async () => {
  const pending = pendingInstall;
  closePreview();
  if (!pending) return;
  const res =
    pending.type === 'code'
      ? await send('userscript:installCode', { code: pending.source, label: '粘贴代码' })
      : await send('userscript:install', { url: pending.source });
  if (res.ok) {
    toast('已安装：' + (res.script && res.script.name));
    switchView('installed');
  } else {
    toast(res.error || '安装失败');
  }
  refreshInstalled();
});

$('us-preview-no').addEventListener('click', closePreview);

$('us-confirm-yes').addEventListener('click', () => closeConfirm(true));
$('us-confirm-no').addEventListener('click', () => closeConfirm(false));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('us-preview-overlay').classList.contains('hidden')) closePreview();
    if (!$('us-confirm-overlay').classList.contains('hidden')) closeConfirm(false);
    return;
  }
  if (e.key === 'Tab') {
    // 焦点陷阱：对话框打开时 Tab / Shift+Tab 在按钮间循环
    const trap = (id: string) => {
      const ov = $(id);
      if (ov.classList.contains('hidden')) return;
      const f = ov.querySelectorAll('.confirm-dialog button:not([disabled])');
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    trap('us-preview-overlay');
    trap('us-confirm-overlay');
  }
});

document.querySelectorAll('.confirm-overlay').forEach((overlay) => {
  overlay.addEventListener('click', (e: Event) => {
    if (e.target === overlay) {
      if (overlay.id === 'us-preview-overlay') closePreview();
      else closeConfirm(false);
    }
  });
});

/* ---------- 启动 ---------- */
(async function init() {
  if (location.hash === '#discover') switchView('discover');
  await refreshInstalled();
  const settings = await getUserscriptSettings();
  if (settings.autoCheckUpdates && scriptsCache.length) updateAll();
})();
