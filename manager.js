// 完整管理页：类型 Tab、标签筛选、搜索、内联编辑、批量操作、导入导出
import { STATUS, ITEM_TYPES, STAR_LEVELS } from './lib/shared/constants.js';
import {
  debounce,
  logError,
  showToast,
  starBarHtml,
  levelNameHtml,
  typeBadgeHtml,
  tagsHtml,
  fmtTime,
  esc,
  sortItems,
  parseTags,
} from './lib/shared/utils.js';
import { getBook, setBook } from './lib/shared/store.js';
import { USERSCRIPTS_KEY } from './lib/userscript/store.js';

let bookCache = {};
let currentType = 'all';
let currentTag = 'all';
let currentStar = 'all';
let sortBy = 'updated';
let editingNoteId = null;
let selectedIds = new Set();

const $ = (id) => document.getElementById(id);

async function loadCache() {
  bookCache = await getBook();
}

async function persist() {
  await setBook(bookCache);
}

function allTags() {
  const map = {};
  Object.values(bookCache).forEach((it) => {
    (it.tags || []).forEach((t) => {
      if (t) map[t] = (map[t] || 0) + 1;
    });
  });
  return Object.keys(map).sort((a, b) => map[b] - map[a]);
}

function renderTypeTabs() {
  const el = $('type-tabs');
  let h = `<button class="type-tab${currentType === 'all' ? ' active' : ''}" data-type="all">全部</button>`;
  ITEM_TYPES.forEach((t) => {
    const n = Object.values(bookCache).filter((i) => (i.type || 'wrong') === t.id).length;
    h += `<button class="type-tab${currentType === t.id ? ' active' : ''}" data-type="${t.id}" style="--t:${t.color}">${t.name} <span class="cnt">${n}</span></button>`;
  });
  el.innerHTML = h;
}

function renderTagFilter() {
  const tags = allTags();
  const el = $('tag-filter');
  if (!tags.length) {
    el.innerHTML = '';
    return;
  }
  let h = `<button class="tag-filter-chip${currentTag === 'all' ? ' active' : ''}" data-tag="all">全部标签</button>`;
  tags.forEach((t) => {
    h += `<button class="tag-filter-chip${currentTag === t ? ' active' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`;
  });
  el.innerHTML = h;
}

function filtered() {
  let items = Object.values(bookCache);
  if (currentType !== 'all') {
    items = items.filter((i) => (i.type || 'wrong') === currentType);
  }
  if (currentTag !== 'all') {
    items = items.filter((i) => (i.tags || []).includes(currentTag));
  }
  if (currentStar !== 'all') {
    items = items.filter((i) => String(i.status) === currentStar);
  }
  // 使用防抖搜索已在事件绑定处处理
  const q = $('search').value.trim().toLowerCase();
  if (q) {
    items = items.filter((i) =>
      (i.title + ' ' + (i.note || '') + ' ' + (i.tags || []).join(' ')).toLowerCase().includes(q)
    );
  }
  return sortItems(items, sortBy);
}

function renderBulkBar() {
  const bar = $('bulk-bar');
  if (selectedIds.size > 0) {
    bar.classList.remove('hidden');
    $('bulk-count').textContent = selectedIds.size + ' 项已选';
    const items = filtered();
    const allSelected = items.length > 0 && items.every((it) => selectedIds.has(it.id));
    $('bulk-select-all-btn').textContent = allSelected ? '取消全选' : '全选';
  } else {
    bar.classList.add('hidden');
  }
}

function toggleSelect(id) {
  if (selectedIds.has(id)) {
    selectedIds.delete(id);
  } else {
    selectedIds.add(id);
  }
  renderBulkBar();
  document.querySelectorAll('.item-select').forEach((cb) => {
    cb.checked = selectedIds.has(cb.closest('.item').dataset.id);
  });
}

function itemHtml(it) {
  const editing = editingNoteId === it.id;
  const titleHtml = editing
    ? `<input id="title-editor" class="note-editor title-editor" value="${esc(it.title)}" placeholder="标题">`
    : it.url
      ? `<span class="item-title" data-open>${esc(it.title)}</span>`
      : `<span class="item-title">${esc(it.title)}</span>`;
  const noteHtml = editing
    ? `<input id="note-editor" class="note-editor" value="${esc(it.note || '')}" placeholder="备注 / 摘要...">`
    : it.note
      ? `<div class="item-note" data-note>${esc(it.note)}</div>`
      : '';
  const tagEditHtml = editing
    ? `<input id="tag-editor" class="note-editor" value="${esc((it.tags || []).join(', '))}" placeholder="标签，逗号分隔">`
    : tagsHtml(it.tags);
  const cbHtml = `<input type="checkbox" class="item-select" ${selectedIds.has(it.id) ? 'checked' : ''}>`;
  return `<div class="item" data-id="${esc(it.id)}">
    <div class="item-head">
      ${cbHtml}
      ${typeBadgeHtml(it.type)}
      ${titleHtml}
      ${editing ? '' : `<span class="time">${fmtTime(it.updatedAt)}</span>`}
    </div>
    <div class="item-meta">
      ${starBarHtml(it.status, true)}
      ${levelNameHtml(it.status)}
      ${it.platformName ? `<span class="pf-name">${esc(it.platformName)}</span>` : ''}
    </div>
    <div class="note-row">${noteHtml}</div>
    <div class="tag-row">${tagEditHtml}</div>
    <div class="item-actions">
      ${editing
        ? `<button class="mini primary" data-act="save">✓ 保存</button><button class="mini" data-act="cancel">✕ 取消</button>`
        : `<button class="mini" data-act="edit">✎ 编辑</button><button class="mini danger" data-act="del">🗑 删除</button>`}
    </div>
  </div>`;
}

function render() {
  const items = filtered();
  const emptyEl = $('empty');
  emptyEl.classList.toggle('hidden', items.length > 0);
  if (!items.length) {
    const hasAny = Object.keys(bookCache).length > 0;
    emptyEl.innerHTML = hasAny
      ? '<span class="empty-ico">🔍</span><p>没有匹配的内容</p><p class="empty-hint">试试更换筛选条件或搜索词</p>'
      : '<span class="empty-ico">📚</span><p>知识库还是空的</p><p class="empty-hint">点击「新建笔记」或收藏网页开始收录</p>';
  }
  $('list').innerHTML = items.map(itemHtml).join('');
  renderTypeTabs();
  renderTagFilter();
  renderStats();
  renderBulkBar();
  renderActiveFilters();
}

function renderActiveFilters() {
  const el = $('active-filter-list');
  const labels = [];
  if (currentType !== 'all') labels.push('类型：' + ((ITEM_TYPES.find((t) => t.id === currentType) || {}).name || currentType));
  if (currentTag !== 'all') labels.push('标签：' + currentTag);
  if (currentStar !== 'all') labels.push('星级：' + currentStar);
  const q = $('search').value.trim();
  if (q) labels.push('搜索：' + q);
  el.innerHTML = labels.length ? labels.map((x) => `<span class="active-filter-chip">${esc(x)}</span>`).join('') : '<span class="filter-empty">全部内容</span>';
}

function renderStats() {
  const all = Object.values(bookCache);
  $('st-total').textContent = all.length;
  [STATUS.GENERAL, STATUS.IMPORTANT, STATUS.FREQUENT].forEach((s) => {
    $('st-' + s).textContent = all.filter((i) => Number(i.status) === s).length;
  });
  document.querySelectorAll('.stars-lbl').forEach((el) => {
    el.innerHTML = starBarHtml(Number(el.dataset.stars), false) + ' ' + (STAR_LEVELS[Number(el.dataset.stars)] || {}).name;
  });
  document.querySelectorAll('.stat-card').forEach((el) => {
    el.classList.toggle('active', el.dataset.s === currentStar);
  });
}

function genId() {
  return 'note-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
}

async function createNote() {
  const id = genId();
  bookCache[id] = {
    id,
    type: 'note',
    title: '新笔记',
    url: '',
    platform: '',
    platformName: '',
    status: STATUS.IMPORTANT,
    note: '',
    tags: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await persist();
  editingNoteId = id;
  render();
  const input = $('note-editor');
  if (input) input.focus();
}

function toast(msg, undoFn) {
  showToast(msg, { undoFn, duration: 3000 });
}

function showConfirm(msg) {
  return new Promise((resolve) => {
    const overlay = $('confirm-overlay');
    $('confirm-msg').textContent = msg;
    overlay.classList.remove('hidden');
    const yes = $('confirm-yes');
    const no = $('confirm-no');
    const cleanup = (result) => {
      overlay.classList.add('hidden');
      overlay.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      yes.removeEventListener('click', onYes);
      no.removeEventListener('click', onNo);
      resolve(result);
    };
    const onYes = () => cleanup(true);
    const onNo = () => cleanup(false);
    const onBackdrop = (e) => {
      if (e.target === overlay) cleanup(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') cleanup(false);
    };
    yes.addEventListener('click', onYes);
    no.addEventListener('click', onNo);
    overlay.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
    yes.focus();
  });
}

async function bulkDelete() {
  if (selectedIds.size === 0) return;
  const count = selectedIds.size;
  const ok = await showConfirm('确定删除 ' + count + ' 项？');
  if (!ok) return;

  const backup = {};
  for (const id of selectedIds) {
    if (bookCache[id]) backup[id] = { ...bookCache[id] };
  }
  for (const id of selectedIds) {
    delete bookCache[id];
  }
  selectedIds.clear();
  await persist();
  render();
  toast(count + ' 项已删除', async () => {
    Object.assign(bookCache, backup);
    await persist();
    render();
    toast('已恢复');
  });
}

$('type-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.type-tab');
  if (!btn) return;
  currentType = btn.dataset.type;
  render();
});

$('tag-filter').addEventListener('click', (e) => {
  const chip = e.target.closest('.tag-filter-chip');
  if (!chip) return;
  currentTag = chip.dataset.tag;
  render();
});

document.querySelectorAll('.stat-card').forEach((el) => {
  el.addEventListener('click', () => {
    currentStar = el.dataset.s;
    render();
  });
});

// 搜索输入添加防抖，避免频繁渲染
$('search').addEventListener('input', debounce(render, 200));
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('search').focus(); }
});
$('clear-filters').addEventListener('click', () => {
  currentType = 'all'; currentTag = 'all'; currentStar = 'all'; $('search').value = ''; render();
});

$('sort-select').addEventListener('change', (e) => {
  sortBy = e.target.value;
  render();
});

$('add-note-btn').addEventListener('click', createNote);

$('list').addEventListener('click', async (e) => {
  const itemEl = e.target.closest('.item');
  if (!itemEl) return;
  const id = itemEl.dataset.id;

  const cb = e.target.closest('.item-select');
  if (cb) {
    toggleSelect(id);
    return;
  }

  if (e.target.closest('.item-note')) {
    editingNoteId = id;
    render();
    const input = $('note-editor');
    if (input) input.focus();
    return;
  }

  const starCell = e.target.closest('.star-cell[data-star]');
  if (starCell) {
    bookCache[id].status = Number(starCell.dataset.star);
    bookCache[id].updatedAt = Date.now();
    await persist();
    render();
    return;
  }

  const act = e.target.closest('[data-act]');
  if (act) {
    const a = act.dataset.act;
    if (a === 'del') {
      const ok = await showConfirm('确定删除"' + (bookCache[id].title || '此条目') + '"？');
      if (!ok) return;
      const backup = { ...bookCache[id] };
      delete bookCache[id];
      if (editingNoteId === id) editingNoteId = null;
      await persist();
      render();
      toast('已删除', async () => {
        bookCache[id] = backup;
        await persist();
        render();
        toast('已恢复');
      });
    } else if (a === 'edit') {
      editingNoteId = id;
      render();
      const input = $('title-editor') || $('note-editor');
      if (input) input.focus();
    } else if (a === 'save') {
      const t = $('title-editor');
      const n = $('note-editor');
      const g = $('tag-editor');
      if (t) bookCache[id].title = t.value.trim() || bookCache[id].title;
      if (n) bookCache[id].note = n.value;
      if (g) bookCache[id].tags = parseTags(g.value);
      bookCache[id].updatedAt = Date.now();
      editingNoteId = null;
      await persist();
      render();
    } else if (a === 'cancel') {
      editingNoteId = null;
      render();
    }
    return;
  }

  if (e.target.closest('.item-title') && bookCache[id] && bookCache[id].url) {
    chrome.tabs.create({ url: bookCache[id].url });
  }
});

$('list').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  if (!editingNoteId) return;
  const t = $('title-editor');
  const n = $('note-editor');
  const g = $('tag-editor');
  if (!t && !n && !g) return;
  if (t) bookCache[editingNoteId].title = t.value.trim() || bookCache[editingNoteId].title;
  if (n) bookCache[editingNoteId].note = n.value;
  if (g) bookCache[editingNoteId].tags = parseTags(g.value);
  bookCache[editingNoteId].updatedAt = Date.now();
  editingNoteId = null;
  await persist();
  render();
});

$('export-btn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(bookCache, null, 2)], {
    type: 'application/json',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '知识库备份.json';
  a.click();
  URL.revokeObjectURL(a.href);
});

$('import-btn').addEventListener('click', () => {
  $('import-file').click();
});

/**
 * 验证导入的数据项是否有效
 * @param {*} item - 待验证的数据项
 * @returns {boolean} 是否有效
 */
function isValidImportItem(item) {
  if (!item || typeof item !== 'object') return false;
  if (typeof item.title !== 'string' || !item.title.trim()) return false;
  // 验证 type 是否合法
  const validTypes = ITEM_TYPES.map((t) => t.id);
  if (item.type && !validTypes.includes(item.type)) return false;
  // 验证 status 是否合法
  if (item.status !== undefined && ![STATUS.GENERAL, STATUS.IMPORTANT, STATUS.FREQUENT].includes(Number(item.status))) {
    return false;
  }
  // 验证 tags 是否为数组
  if (item.tags && !Array.isArray(item.tags)) return false;
  // 验证 url 是否为字符串
  if (item.url && typeof item.url !== 'string') return false;
  return true;
}

$('import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      toast('无效的 JSON 格式：应为对象');
      return;
    }

    let count = 0;
    let skipped = 0;
    for (const [id, item] of Object.entries(data)) {
      if (isValidImportItem(item)) {
        if (bookCache[id]) {
          bookCache[id] = { ...bookCache[id], ...item, id, updatedAt: Date.now() };
        } else {
          bookCache[id] = { ...item, id, createdAt: item.createdAt || Date.now(), updatedAt: Date.now() };
        }
        count++;
      } else {
        skipped++;
        logError('Skipped invalid import item', { id, item });
      }
    }
    await persist();
    render();
    toast(skipped > 0 ? `已导入 ${count} 项，跳过 ${skipped} 项无效数据` : `已导入 ${count} 项`);
  } catch (err) {
    toast('导入失败：' + err.message);
    logError('Import failed', err);
  }
  e.target.value = '';
});

$('bulk-delete-btn').addEventListener('click', bulkDelete);

$('bulk-select-all-btn').addEventListener('click', () => {
  const items = filtered();
  const allSelected = items.length > 0 && items.every((it) => selectedIds.has(it.id));
  items.forEach((it) => {
    if (allSelected) selectedIds.delete(it.id);
    else selectedIds.add(it.id);
  });
  render();
});

$('bulk-cancel-btn').addEventListener('click', () => {
  selectedIds.clear();
  render();
});

document.addEventListener('keydown', (e) => {
  // 确认弹窗打开时，交给弹窗自己的键盘处理，避免快捷键误触发
  if (!$('confirm-overlay').classList.contains('hidden')) return;
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    $('search').focus();
  }
  // Ctrl+A 全选当前筛选结果
  if ((e.ctrlKey || e.metaKey) && e.key === 'a' && document.activeElement.tagName !== 'INPUT') {
    e.preventDefault();
    filtered().forEach((it) => selectedIds.add(it.id));
    render();
  }
  // Delete 键批量删除已选项
  if (e.key === 'Delete' && selectedIds.size > 0 && document.activeElement.tagName !== 'INPUT') {
    bulkDelete();
  }
  if (e.key === 'Escape') {
    if (editingNoteId) {
      editingNoteId = null;
      render();
      return;
    }
    if (selectedIds.size > 0) {
      selectedIds.clear();
      render();
    }
  }
});

// ---- 引用来源定位高亮 ----
// URL 形如 manager.html#focus=<id>：重置筛选、滚动到条目并高亮闪烁
function focusItemFromHash() {
  const m = location.hash.match(/#focus=([^&]+)/);
  if (!m) return;
  const id = decodeURIComponent(m[1]);
  if (!bookCache[id]) {
    toast('未找到该条目（可能已被删除）');
    return;
  }
  // 重置筛选条件，确保目标条目可见
  currentType = 'all';
  currentTag = 'all';
  currentStar = 'all';
  $('search').value = '';
  editingNoteId = null;
  render();

  const el = document.querySelector('.item[data-id="' + CSS.escape(id) + '"]');
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('flash-highlight');
  setTimeout(() => el.classList.remove('flash-highlight'), 2600);
  // 清理 hash，避免刷新后重复触发
  if (history.replaceState) history.replaceState(null, '', location.pathname + location.search);
}

(async function init() {
  await loadCache();
  renderUserscriptBadge();
  render();
  focusItemFromHash();
})();

async function renderUserscriptBadge() {
  const badge = $('us-count-badge');
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
