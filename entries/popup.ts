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
import { createKnowledgeRepository } from '../lib/shared/knowledge-repository.ts';
import type { KnowledgeItem } from '../lib/shared/store.ts';
import { USERSCRIPTS_KEY } from '../lib/userscript/store.ts';

const knowledge = createKnowledgeRepository();
let currentTab: chrome.tabs.Tab | null = null;
let currentUrl: string | null = null;
let currentTitle: string | null = null;
// 收录面板只在「当前页可收录」分支里读它；原代码同样不检查 null。
let platform!: { id: string; name: string };
let selectedType = 'wrong';
let selectedStatus: number | string = STATUS.IMPORTANT;
let currentFilter = 'all';
let sortBy = 'updated';
let listQuery = '';
const ADD_COLLAPSED_KEY = 'recallflow-popup-add-collapsed';
const POPUP_RECENT_LIMIT = 5;

/**
 * 按 id 取元素。这些 id 全部写死在 popup.html 里，取不到就是模板坏了 ——
 * 原代码不做 null 检查（直接 .value / .disabled），这里保持同一取舍，
 * 用 `any` 承接「具体是 input 还是 button 由模板决定」这件事。
 */
const $ = (id: string): any => document.getElementById(id);

/** 事件目标 → 最近的匹配元素（原代码直接 e.target.closest(...)）。 */
const closest = (target: EventTarget | null, selector: string): any =>
  target ? (target as Element).closest(selector) : null;

function toast(msg: string, undoFn?: (() => unknown) | null) {
  showToast(msg, { duration: 4000, undoFn });
}

function renderTypePicker() {
  const el = document.querySelector('#add-panel .type-group') as HTMLElement;
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
  let items = knowledge.list();
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
  const total = knowledge.size;
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

function itemHtml(it: KnowledgeItem): string {
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
  await knowledge.load();
  renderList();
  renderScriptsBadge();
  const shortcut = $('search-shortcut');
  if (shortcut) {
    const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
    // 名字刻意不叫 platform：模块级已有同名变量，同名 const 会让「对 const 赋值」门禁
    // 把模块级的赋值误算到这条 const 上（TITA-86 实测）。
    const uaPlatform = (uaData && uaData.platform) || navigator.platform || '';
    shortcut.textContent = /mac/i.test(uaPlatform) ? '⌘ K' : 'Ctrl K';
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

    const rec = knowledge.get(currentUrl);
    if (rec) {
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
    badge.textContent = String(count);
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
    await knowledge.upsert({
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
  $(id).addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (id === 'note-input' && !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      $('add-btn').click();
    }
  });
});

document.querySelector('#add-panel .type-group')!.addEventListener('click', (e) => {
  const btn = closest(e.target, '.type-btn');
  if (!btn) return;
  selectedType = btn.dataset.type;
  renderTypePicker();
});

document.querySelector('#add-panel .star-picker')!.addEventListener('click', (e) => {
  const cell = closest(e.target, '.star-cell[data-star]');
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
    const id = (itemEl as HTMLElement).dataset.id as string;
    if (knowledge.get(id)) {
      void knowledge
        .update(id, (item) => ({ ...item, status: v, updatedAt: Date.now() }))
        .catch(() => toast('更新失败，请重试'));
      const lvl = itemEl.querySelector('.level-name');
      if (lvl) lvl.outerHTML = levelNameHtml(v);
    }
  }
});

document.querySelectorAll('.filter-chip').forEach((c) => {
  c.addEventListener('click', () => {
    currentFilter = (c as HTMLElement).dataset.filter as string;
    document.querySelectorAll('.filter-chip').forEach((x) => {
      x.classList.toggle('active', x === c);
      x.setAttribute('aria-pressed', x === c ? 'true' : 'false');
    });
    renderList();
  });
});

$('sort-select').addEventListener('change', (e: Event) => {
  sortBy = (e.target as HTMLSelectElement).value;
  renderList();
});

$('list-search').addEventListener('input', debounce(() => {
  listQuery = $('list-search').value;
  renderList();
}, 200));

function setAddPanelCollapsed(collapsed: boolean, persist: boolean = true) {
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

$('list').addEventListener('click', async (e: Event) => {
  const itemEl = closest(e.target, '.item');
  if (!itemEl) return;
  const id = itemEl.dataset.id;

  if (closest(e.target, '.del')) {
    const removed = knowledge.get(id);
    await knowledge.remove(id);
    renderList();
    toast('已删除', async () => {
      if (!removed) return;
      await knowledge.put({ ...removed, tags: removed.tags.slice() });
      renderList();
      toast('已恢复');
    });
    return;
  }

  const item = knowledge.get(id);
  if (closest(e.target, '.open') && item && item.url) {
    chrome.tabs.create({ url: item.url });
    return;
  }

  const starCell = closest(e.target, '.star-cell[data-star]');
  if (starCell) {
    const a = Number(starCell.dataset.star);
    const validStatuses = [STATUS.GENERAL, STATUS.IMPORTANT, STATUS.FREQUENT];
    if (item && validStatuses.includes(a)) {
      await knowledge.update(id, (current) => ({ ...current, status: a, updatedAt: Date.now() }));
      // 就地更新，避免整列表 renderList() 导致焦点 / 滚动丢失
      const bar = itemEl.querySelector('.star-bar');
      if (bar) bar.querySelectorAll('.star-cell').forEach((c: Element, i: number) => c.classList.toggle('on', i < a));
      const lvl = itemEl.querySelector('.level-name');
      if (lvl) lvl.outerHTML = levelNameHtml(a);
    }
    return;
  }

  if (closest(e.target, '.item-title') && item && item.url) {
    chrome.tabs.create({ url: item.url });
  }
});

const openManager = (e: Event) => {
  e.preventDefault();
  // 带上当前条目 id，复用 manager 的 #focus 高亮定位，打通「收录→管理」闭环
  const id = currentUrl && knowledge.get(currentUrl) ? currentUrl : null;
  const url = chrome.runtime.getURL('manager.html') + (id ? `#focus=${encodeURIComponent(id)}` : '');
  chrome.tabs.create({ url });
};
$('open-manager').addEventListener('click', openManager);
$('open-manager-top').addEventListener('click', openManager);
$('open-manager-all').addEventListener('click', openManager);

$('open-scripts').addEventListener('click', (e: Event) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('userscripts.html') });
});

const openSkillsBtn = $('open-skills');
if (openSkillsBtn) openSkillsBtn.addEventListener('click', (e: Event) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('skills.html') });
});

$('open-settings').addEventListener('click', (e: Event) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

$('open-assistant').addEventListener('click', async () => {
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let tab: chrome.tabs.Tab | undefined = activeTab;
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

knowledge.subscribe(() => {
  renderList();
});

window.addEventListener('pagehide', (event) => {
  if (!event.persisted) knowledge.dispose();
});

init();
