// 弹窗（快速收录 + 列表）
import { STATUS, ITEM_TYPES } from '../lib/shared/constants.ts';
import {
  showToast,
  debounce,
  starBarHtml,
  levelNameHtml,
  sortItems,
  esc,
  markdownExcerpt,
  typeBadgeHtml,
  tagsHtml,
  fmtTime,
  bindStarKeyboard,
  isFileUrl,
  isOperableUrl,
  normalizeUrl,
  cleanTitle,
  detectPlatform,
  detectType,
  platformColor,
  parseTags,
} from '../lib/shared/utils.ts';
import { getBook, setBook, upsertItem, subscribeKnowledgeChanges } from '../lib/shared/store.js';
import { USERSCRIPTS_KEY } from '../lib/userscript/store.ts';

let bookCache = {};
let currentTab = null;
let currentUrl = null;
let currentTitle = null;
let platform = null;
let selectedType = 'wrong';
let selectedStatus = STATUS.IMPORTANT;
let currentFilter = 'all';
let sortBy = 'updated';
let listQuery = '';
const ADD_COLLAPSED_KEY = 'recallflow-popup-add-collapsed';
const POPUP_RECENT_LIMIT = 5;

const $ = (id) => document.getElementById(id);

function toast(msg, undoFn) {
  showToast(msg, { duration: 4000, undoFn });
}

async function loadCache() {
  bookCache = await getBook();
}

async function persist() {
  await setBook(bookCache);
}

function renderTypePicker() {
  const el = document.querySelector('#add-panel .type-group');
  el.innerHTML = ITEM_TYPES.map(
    (t) => `<button class="type-btn${selectedType === t.id ? ' active' : ''}" data-type="${t.id}" aria-pressed="${selectedType === t.id}" style="--t:${t.color}">${t.name}</button>`
  ).join('');
}

function syncStatusHighlight() {
  const barEl = document.querySelector('#add-panel .star-picker');
  if (!barEl) return;
  barEl.innerHTML = starBarHtml(selectedStatus, true);
  const nameEl = document.querySelector('#add-panel .star-picker-name');
  if (nameEl) nameEl.innerHTML = levelNameHtml(selectedStatus);
}

function renderList() {
  const listEl = $('list');
  const emptyEl = $('empty');
  let items = Object.values(bookCache);
  if (currentFilter !== 'all') {
    items = items.filter((i) => (i.type || 'wrong') === currentFilter);
  }
  const query = listQuery.trim().toLowerCase();
  const hasFilters = currentFilter !== 'all' || Boolean(query);
  if (query) {
    items = items.filter((i) => `${i.title || ''} ${i.note || ''} ${(i.tags || []).join(' ')}`.toLowerCase().includes(query));
  }
  items = sortItems(items, sortBy);

  emptyEl.classList.toggle('hidden', items.length > 0);
  if (!items.length) {
    emptyEl.innerHTML = hasFilters
      ? '<span class="empty-ico">⌕</span><p>没有匹配的内容</p><p class="empty-hint">试试更换筛选条件或搜索词</p>'
      : '<span class="empty-ico">📚</span><p>还没有内容</p><p class="empty-hint">打开网页后点工具栏图标即可快速收录</p>';
  }
  const total = Object.keys(bookCache).length;
  const shown = items.slice(0, POPUP_RECENT_LIMIT);
  listEl.innerHTML = shown.map(itemHtml).join('');
  $('total-badge').textContent = total + ' 条';
  const visible = $('visible-count');
  if (visible) {
    visible.textContent = items.length
      ? hasFilters
        ? `· 筛选 ${items.length} 条，显示前 ${shown.length} 条`
        : `· 显示最近 ${shown.length} 条 / 共 ${total} 条`
      : '';
  }
  const viewAll = $('open-manager-all');
  if (viewAll) {
    viewAll.classList.toggle('hidden', total === 0);
    $('view-all-label').textContent = hasFilters ? '在知识库查看筛选结果' : '在知识库查看全部';
    $('all-items-count').textContent = String(hasFilters ? items.length : total);
    viewAll.title = hasFilters ? '打开知识库查看完整筛选结果' : '打开知识库查看全部内容';
  }
}

function itemHtml(it) {
  const type = it.type || 'wrong';
  const urlLink = it.url
    ? `<span class="item-title" title="${esc(it.url)}">${esc(it.title)}</span>`
    : `<span class="item-title no-link">${esc(it.title)}</span>`;
  return `<div class="item" data-id="${esc(it.id)}">
    <div class="item-head">
      ${typeBadgeHtml(type)}
      ${urlLink}
      ${it.url ? '<button class="icon-btn open" title="打开原文" aria-label="打开原文">↗</button>' : ''}
      <button class="icon-btn del" title="删除" aria-label="删除条目">✕</button>
    </div>
    ${it.note ? `<div class="item-note">${esc(markdownExcerpt(it.note, 120))}</div>` : ''}
    ${tagsHtml(it.tags)}
    <div class="item-meta">
      ${starBarHtml(it.status, true)}
      ${levelNameHtml(it.status)}
      ${it.platformName ? `<span class="platform-mini">${esc(it.platformName)}</span>` : ''}
      <span class="time">${fmtTime(it.updatedAt)}</span>
    </div>
  </div>`;
}

/**
 * 扩展有没有「允许访问文件网址」。
 *
 * 这是**用户级开关**（chrome://extensions → 本扩展 → 详情）。manifest 里写 `file:///*`
 * 只是"申请"：用户不打开这个开关，内容脚本根本不会注入到本地页，而且是**静默**不注入 ——
 * 面板不出现、快捷键没反应、收藏也存不了，用户看到的只是"它坏了"。
 * 所以先问一句，把原因直说出去，别让他猜。
 */
function isAllowedFileSchemeAccess() {
  return new Promise((resolve) => {
    try {
      if (!chrome.extension || typeof chrome.extension.isAllowedFileSchemeAccess !== 'function') {
        resolve(true);
        return;
      }
      chrome.extension.isAllowedFileSchemeAccess((allowed) => resolve(allowed === true));
    } catch (e) {
      resolve(true);
    }
  });
}

async function init() {
  await loadCache();
  renderList();
  renderScriptsBadge();
  const shortcut = $('search-shortcut');
  if (shortcut) {
    const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    shortcut.textContent = /mac/i.test(platform) ? '⌘ K' : 'Ctrl K';
  }

  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  // 本地页（file://）只要用户开了「允许访问文件网址」，就和普通网页一样可收录、可开助手；
  // 没开时把"为什么不行"直接写在页面上，而不是笼统说"页面不支持"。
  const localFileBlocked = Boolean(t && t.url && isFileUrl(t.url) && !(await isAllowedFileSchemeAccess()));
  if (t && t.url && isOperableUrl(t.url) && !localFileBlocked) {
    currentTab = t;
    currentUrl = normalizeUrl(t.url);
    currentTitle = cleanTitle(t.title) || t.url;
    platform = detectPlatform(t.url);
    $('add-panel').classList.remove('hidden');
    $('page-unavailable').classList.add('hidden');
    selectedType = detectType(t.url);

    $('add-title').textContent = currentTitle;
    const pEl = $('add-platform');
    pEl.textContent = platform.name;
    pEl.style.background = platformColor(platform.id);
    pEl.classList.remove('hidden');

    if (bookCache[currentUrl]) {
      const rec = bookCache[currentUrl];
      $('add-exists').classList.remove('hidden');
      selectedType = rec.type || 'wrong';
      selectedStatus = rec.status;
      $('tags-input').value = (rec.tags || []).join(', ');
      $('note-input').value = rec.note || '';
      $('add-btn').textContent = '更新';
    }
  } else {
    $('add-panel').classList.add('hidden');
    $('page-unavailable').classList.remove('hidden');
    const hint = $('unavailable-hint');
    if (hint) {
      hint.textContent = localFileBlocked
        ? '本地网页：请在扩展详情里打开「允许访问文件网址」'
        : '请打开普通网页后再试';
    }
  }
  renderTypePicker();
  syncStatusHighlight();
  try {
    setAddPanelCollapsed(localStorage.getItem(ADD_COLLAPSED_KEY) === '1', false);
  } catch (e) {}
}

async function renderScriptsBadge() {
  const badge = document.getElementById('scripts-badge');
  if (!badge) return;
  try {
    const data = await chrome.storage.local.get(USERSCRIPTS_KEY);
    const count = Object.keys(data[USERSCRIPTS_KEY] || {}).length;
    badge.textContent = count;
    badge.classList.toggle('hidden', count === 0);
  } catch (e) {
    badge.classList.add('hidden');
  }
}

$('add-btn').addEventListener('click', async () => {
  if (!currentUrl) return;
  const btn = $('add-btn');
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  btn.textContent = '保存中…';
  try {
    const tags = parseTags($('tags-input').value);
    await upsertItem({
      id: currentUrl,
      type: selectedType,
      title: currentTitle,
      url: currentUrl,
      platformId: platform.id,
      platformName: platform.name,
      status: selectedStatus,
      note: $('note-input').value,
      tags,
    });
    await loadCache();
    $('add-exists').classList.remove('hidden');
    btn.textContent = '已保存 ✓';
    renderList();
    toast('已收录到知识库');
    setTimeout(() => { if (btn.isConnected) btn.textContent = '更新'; }, 1400);
  } catch (err) {
    btn.textContent = '保存失败，重试';
    toast('保存失败，请重试');
  } finally {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
  }
});

['tags-input', 'note-input'].forEach((id) => {
  $(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (id === 'note-input' && !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      $('add-btn').click();
    }
  });
});

document.querySelector('#add-panel .type-group').addEventListener('click', (e) => {
  const btn = e.target.closest('.type-btn');
  if (!btn) return;
  selectedType = btn.dataset.type;
  renderTypePicker();
});

document.querySelector('#add-panel .star-picker').addEventListener('click', (e) => {
  const cell = e.target.closest('.star-cell[data-star]');
  if (!cell) return;
  selectedStatus = Number(cell.dataset.star);
  syncStatusHighlight();
});

// 星级键盘可达（popup 既有收藏面板，也有列表项）
bindStarKeyboard(document, (v, cell) => {
  const picker = cell.closest('#add-panel .star-picker');
  if (picker) {
    selectedStatus = v;
    const nameEl = document.querySelector('#add-panel .star-picker-name');
    if (nameEl) nameEl.innerHTML = levelNameHtml(v);
    return;
  }
  const itemEl = cell.closest('.item');
  if (itemEl) {
    const id = itemEl.dataset.id;
    if (bookCache[id]) {
      bookCache[id].status = v;
      bookCache[id].updatedAt = Date.now();
      persist();
      const lvl = itemEl.querySelector('.level-name');
      if (lvl) lvl.outerHTML = levelNameHtml(v);
    }
  }
});

document.querySelectorAll('.filter-chip').forEach((c) => {
  c.addEventListener('click', () => {
    currentFilter = c.dataset.filter;
    document.querySelectorAll('.filter-chip').forEach((x) => {
      x.classList.toggle('active', x === c);
      x.setAttribute('aria-pressed', x === c ? 'true' : 'false');
    });
    renderList();
  });
});

$('sort-select').addEventListener('change', (e) => {
  sortBy = e.target.value;
  renderList();
});

$('list-search').addEventListener('input', debounce(() => {
  listQuery = $('list-search').value;
  renderList();
}, 200));

function setAddPanelCollapsed(collapsed, persist = true) {
  const addPanel = $('add-panel');
  const toggle = $('toggle-add-panel');
  addPanel.classList.toggle('is-collapsed', collapsed);
  toggle.textContent = collapsed ? '展开' : '收起';
  toggle.setAttribute('aria-expanded', String(!collapsed));
  if (persist) {
    try { localStorage.setItem(ADD_COLLAPSED_KEY, collapsed ? '1' : '0'); } catch (e) {}
  }
}

$('toggle-add-panel').addEventListener('click', () => {
  setAddPanelCollapsed(!$('add-panel').classList.contains('is-collapsed'));
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    $('list-search').focus();
  }
});

$('list').addEventListener('click', async (e) => {
  const itemEl = e.target.closest('.item');
  if (!itemEl) return;
  const id = itemEl.dataset.id;

  if (e.target.closest('.del')) {
    const removed = bookCache[id];
    delete bookCache[id];
    await persist();
    renderList();
    toast('已删除', async () => {
      if (!removed) return;
      bookCache[id] = removed;
      await persist();
      renderList();
      toast('已恢复');
    });
    return;
  }

  if (e.target.closest('.open') && bookCache[id] && bookCache[id].url) {
    chrome.tabs.create({ url: bookCache[id].url });
    return;
  }

  const starCell = e.target.closest('.star-cell[data-star]');
  if (starCell) {
    const a = Number(starCell.dataset.star);
    const validStatuses = [STATUS.GENERAL, STATUS.IMPORTANT, STATUS.FREQUENT];
    if (bookCache[id] && validStatuses.includes(a)) {
      bookCache[id].status = a;
      bookCache[id].updatedAt = Date.now();
      await persist();
      // 就地更新，避免整列表 renderList() 导致焦点 / 滚动丢失
      const bar = itemEl.querySelector('.star-bar');
      if (bar) bar.querySelectorAll('.star-cell').forEach((c, i) => c.classList.toggle('on', i < a));
      const lvl = itemEl.querySelector('.level-name');
      if (lvl) lvl.outerHTML = levelNameHtml(a);
    }
    return;
  }

  if (e.target.closest('.item-title') && bookCache[id] && bookCache[id].url) {
    chrome.tabs.create({ url: bookCache[id].url });
  }
});

const openManager = (e) => {
  e.preventDefault();
  // 带上当前条目 id，复用 manager 的 #focus 高亮定位，打通「收录→管理」闭环
  const id = currentUrl && bookCache[currentUrl] ? currentUrl : null;
  const url = chrome.runtime.getURL('manager.html') + (id ? `#focus=${encodeURIComponent(id)}` : '');
  chrome.tabs.create({ url });
};
$('open-manager').addEventListener('click', openManager);
$('open-manager-top').addEventListener('click', openManager);
$('open-manager-all').addEventListener('click', openManager);

$('open-scripts').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('userscripts.html') });
});

const openSkillsBtn = $('open-skills');
if (openSkillsBtn) openSkillsBtn.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('skills.html') });
});

$('open-settings').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

$('open-assistant').addEventListener('click', async () => {
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let tab = activeTab;
    // 正常 popup 的 active tab 就是当前网页；把 popup.html 当普通标签页打开时，
    // active tab 会是扩展页本身，此时回退到同窗口最近一个可注入的网页。
    if (!tab || !tab.url || !isOperableUrl(tab.url)) {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      tab = tabs.find((item) => item && item.url && isOperableUrl(item.url));
    }
    if (!tab || !tab.url || !isOperableUrl(tab.url)) {
      toast('请先打开一个网页');
      return;
    }
    chrome.runtime.sendMessage({ type: 'panel:open-active', tabId: tab.id }, () => {
      if (chrome.runtime.lastError) toast('无法打开助手，请刷新页面后重试');
      else setTimeout(() => window.close(), 80);
    });
  } catch (e) {
    toast('无法打开助手，请刷新页面后重试');
  }
});

subscribeKnowledgeChanges(async () => {
  await loadCache();
  renderList();
});

init();
