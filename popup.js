// 弹窗（快速收录 + 列表）
import { STATUS, ITEM_TYPES } from './lib/shared/constants.js';
import {
  showToast,
  starBarHtml,
  levelNameHtml,
  sortItems,
  esc,
  typeBadgeHtml,
  tagsHtml,
  fmtTime,
  isWebUrl,
  normalizeUrl,
  cleanTitle,
  detectPlatform,
  detectType,
  platformColor,
  parseTags,
} from './lib/shared/utils.js';
import { getBook, setBook, upsertItem } from './lib/shared/store.js';
import { USERSCRIPTS_KEY } from './lib/userscript/store.js';

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

const $ = (id) => document.getElementById(id);

function toast(msg, undoFn) {
  showToast(msg, { duration: 2600, undoFn });
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
  if (query) {
    items = items.filter((i) => `${i.title || ''} ${i.note || ''} ${(i.tags || []).join(' ')}`.toLowerCase().includes(query));
  }
  items = sortItems(items, sortBy);

  emptyEl.classList.toggle('hidden', items.length > 0);
  if (!items.length) {
    const hasFilters = currentFilter !== 'all' || query;
    emptyEl.innerHTML = hasFilters
      ? '<span class="empty-ico">⌕</span><p>没有匹配的内容</p><p class="empty-hint">试试更换筛选条件或搜索词</p>'
      : '<span class="empty-ico">📚</span><p>还没有内容</p><p class="empty-hint">打开网页后点工具栏图标即可快速收录</p>';
  }
  listEl.innerHTML = items.map(itemHtml).join('');
  const total = Object.keys(bookCache).length;
  $('total-badge').textContent = total + ' 条';
  const visible = $('visible-count');
  if (visible) visible.textContent = items.length === total ? '' : `· ${items.length}/${total}`;
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
    ${it.note ? `<div class="item-note">${esc(it.note)}</div>` : ''}
    ${tagsHtml(it.tags)}
    <div class="item-meta">
      ${starBarHtml(it.status, true)}
      ${levelNameHtml(it.status)}
      ${it.platformName ? `<span class="platform-mini">${esc(it.platformName)}</span>` : ''}
      <span class="time">${fmtTime(it.updatedAt)}</span>
    </div>
  </div>`;
}

async function init() {
  await loadCache();
  renderTypePicker();
  renderList();
  renderScriptsBadge();

  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (t && t.url && isWebUrl(t.url)) {
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
  }
  renderTypePicker();
  syncStatusHighlight();
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

$('list-search').addEventListener('input', (e) => {
  listQuery = e.target.value;
  renderList();
});

$('toggle-add-panel').addEventListener('click', () => {
  const addPanel = $('add-panel');
  const collapsed = addPanel.classList.toggle('is-collapsed');
  const toggle = $('toggle-add-panel');
  toggle.textContent = collapsed ? '展开' : '收起';
  toggle.setAttribute('aria-expanded', String(!collapsed));
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
      renderList();
    }
    return;
  }

  if (e.target.closest('.item-title') && bookCache[id] && bookCache[id].url) {
    chrome.tabs.create({ url: bookCache[id].url });
  }
});

const openManager = (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('manager.html') });
};
$('open-manager').addEventListener('click', openManager);
$('open-manager-top').addEventListener('click', openManager);

$('open-scripts').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('userscripts.html') });
});

$('open-settings').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

init();
