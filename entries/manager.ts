// 完整管理页：类型 Tab、标签筛选、搜索、内联编辑、批量操作、导入导出
import { STATUS, ITEM_TYPES, STAR_LEVELS } from '../lib/shared/constants.ts';
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
  markdownExcerpt,
  parseTags,
  bindStarKeyboard,
} from '../lib/shared/utils.ts';
import { sortItems } from '../lib/domain/knowledge/query.ts';
import { createKnowledgeRepository } from '../lib/application/knowledge/repository.ts';
import { createChromeTabsAdapter } from '../lib/adapters/chrome/tabs.ts';
import type { KnowledgeItem } from '../lib/shared/store.ts';
import { USERSCRIPTS_KEY } from '../lib/userscript/store.ts';
import { renderMarkdown } from '../lib/page/markdown.ts';
import { clampPage, pageSlice, pageTokens } from '../lib/shared/pagination.ts';

const knowledge = createKnowledgeRepository();
const tabsPort = createChromeTabsAdapter();

/** 按 id 取元素：id 全部写死在 manager.html 里（取不到就是模板坏了，原代码也不检查）。 */
const $ = (id: string): any => document.getElementById(id);

/** 事件目标 → 最近的匹配元素（原代码直接 closestEl(e.target, ...)）。 */
const closestEl = (target: EventTarget | null, selector: string): any =>
  target ? (target as Element).closest(selector) : null;

let currentType = 'all';
let currentTag = 'all';
let currentStar = 'all';
let sortBy = 'updated';
const KB_PAGE_SIZE = 12;
let currentPage = 1;
let editingNoteId: string | null = null;
let selectedIds = new Set<string>();

let docItemId = '';
let docPreviousFocus: HTMLElement | null = null;
let docKeyHandler: ((e: KeyboardEvent) => void) | null = null;

function allTags(): string[] {
  const map: Record<string, number> = {};
  knowledge.list().forEach((it) => {
    (it.tags || []).forEach((t) => {
      if (t) map[t] = (map[t] || 0) + 1;
    });
  });
  return Object.keys(map).sort((a, b) => map[b] - map[a]);
}

function renderTypeTabs() {
  const el = $('type-tabs');
  const all = knowledge.list();
  let h = `<button class="type-tab${currentType === 'all' ? ' active' : ''}" data-type="all">全部</button>`;
  ITEM_TYPES.forEach((t) => {
    const n = all.filter((i) => (i.type || 'wrong') === t.id).length;
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

function filtered(): KnowledgeItem[] {
  let items = knowledge.list();
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

function toggleSelect(id: string) {
  if (selectedIds.has(id)) {
    selectedIds.delete(id);
  } else {
    selectedIds.add(id);
  }
  renderBulkBar();
  document.querySelectorAll('.item-select').forEach((cb) => {
    const box = cb as HTMLInputElement;
    box.checked = selectedIds.has((box.closest('.item') as HTMLElement).dataset.id as string);
  });
}

function itemHtml(it: KnowledgeItem): string {
  const editing = editingNoteId === it.id;
  const titleHtml = editing
    ? `<input id="title-editor" class="note-editor title-editor" value="${esc(it.title)}" placeholder="标题">`
    : it.url
      ? `<span class="item-title" data-open>${esc(it.title)}</span>`
      : `<span class="item-title" data-doc-open title="打开 Markdown 文档">${esc(it.title)}</span>`;
  const noteHtml = editing
    ? `<div class="doc-editor-wrap">
        <div class="doc-editor-hint">支持 Markdown · Ctrl/⌘ + Enter 保存</div>
        <textarea id="note-editor" class="note-editor doc-editor" rows="8" placeholder="写 Markdown 文档，支持标题、列表、表格、代码块和链接…">${esc(it.note || '')}</textarea>
      </div>`
    : it.note
      ? `<div class="item-note" data-note>${esc(markdownExcerpt(it.note, 180))}</div>`
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
        : `<button class="mini" data-act="read">📖 阅读</button><button class="mini" data-act="edit">✎ 编辑</button><button class="mini danger" data-act="del">🗑 删除</button>`}
    </div>
  </div>`;
}

// 就地更新单条目星级（避免整列表 render() 丢失焦点 / 滚动位置）
function updateItemStar(itemEl: Element, v: number) {
  const bar = itemEl.querySelector('.star-bar');
  if (bar) {
    bar.querySelectorAll('.star-cell').forEach((c, i) => {
      const on = i < v;
      c.classList.toggle('on', on);
      (c as HTMLElement).tabIndex = i === v - 1 ? 0 : -1;
      c.setAttribute('aria-checked', String(on));
    });
  }
  const lvl = itemEl.querySelector('.level-name');
  if (lvl) lvl.outerHTML = levelNameHtml(v);
}

function renderPagination(total: number, pageCount: number) {
  const nav = $('kb-pagination');
  if (!nav) return;
  const current = clampPage(currentPage, pageCount);
  currentPage = current;
  if (!total || pageCount <= 1) {
    nav.innerHTML = '';
    nav.hidden = true;
    return;
  }
  nav.hidden = false;
  const tokens = pageTokens(current, pageCount);
  nav.innerHTML =
    '<span class="kb-page-summary">第 ' + current + ' / ' + pageCount + ' 页 · ' + KB_PAGE_SIZE + ' 条/页</span>' +
    '<button class="kb-page-btn" type="button" data-page="' + (current - 1) + '"' + (current === 1 ? ' disabled' : '') + '>上一页</button>' +
    tokens.map((token) => {
      if (token === 'ellipsis') return '<span class="kb-page-ellipsis" aria-hidden="true">…</span>';
      return '<button class="kb-page-btn' + (token === current ? ' active' : '') + '" type="button" data-page="' + token + '"' +
        (token === current ? ' aria-current="page"' : '') + '>' + token + '</button>';
    }).join('') +
    '<button class="kb-page-btn" type="button" data-page="' + (current + 1) + '"' + (current === pageCount ? ' disabled' : '') + '>下一页</button>';
}

function render() {
  const listEl = $('list');
  const prevTop = listEl.scrollTop; // 记录滚动位置，避免编辑/改星后跳回顶部
  const items = filtered();
  const paged = pageSlice(items, currentPage, KB_PAGE_SIZE);
  currentPage = paged.page;
  const emptyEl = $('empty');
  emptyEl.classList.toggle('hidden', items.length > 0);
  if (!items.length) {
    const hasAny = knowledge.size > 0;
    emptyEl.innerHTML = hasAny
      ? '<span class="empty-ico">🔍</span><p>没有匹配的内容</p><p class="empty-hint">试试更换筛选条件或搜索词</p>'
      : '<span class="empty-ico">📚</span><p>知识库还是空的</p><p class="empty-hint">点击「新建笔记」或收藏网页开始收录</p>';
  }
  listEl.innerHTML = paged.items.map(itemHtml).join('');
  listEl.scrollTop = prevTop; // 恢复滚动位置
  renderTypeTabs();
  renderTagFilter();
  renderStats();
  renderBulkBar();
  renderActiveFilters();
  renderPagination(paged.total, paged.pageCount);
}

function renderActiveFilters() {
  const el = $('active-filter-list');
  const labels = [];
  if (currentType !== 'all') labels.push('类型：' + (ITEM_TYPES.find((t) => t.id === currentType)?.name || currentType));
  if (currentTag !== 'all') labels.push('标签：' + currentTag);
  if (currentStar !== 'all') labels.push('星级：' + currentStar);
  const q = $('search').value.trim();
  if (q) labels.push('搜索：' + q);
  el.innerHTML = labels.length ? labels.map((x) => `<span class="active-filter-chip">${esc(x)}</span>`).join('') : '<span class="filter-empty">全部内容</span>';
  const summary = $('advanced-filter-summary');
  if (summary) summary.textContent = labels.length ? labels.join(' · ') : '全部内容';
  const details = $('advanced-filters');
  if (details && labels.length) details.open = true;
}

function renderStats() {
  const all = knowledge.list();
  $('st-total').textContent = String(all.length);
  [STATUS.GENERAL, STATUS.IMPORTANT, STATUS.FREQUENT].forEach((s) => {
    $('st-' + s).textContent = String(all.filter((i) => Number(i.status) === s).length);
  });
  document.querySelectorAll('.stars-lbl').forEach((el) => {
    const stars = Number((el as HTMLElement).dataset.stars);
    el.innerHTML = starBarHtml(stars, false) + ' ' + (STAR_LEVELS[stars] || {}).name;
  });
  document.querySelectorAll('.stat-card').forEach((el) => {
    el.classList.toggle('active', (el as HTMLElement).dataset.s === currentStar);
  });
}

function genId() {
  return 'note-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
}

async function saveEditingItem(id: string) {
  const titleInput = $('title-editor') as HTMLInputElement | null;
  const noteInput = $('note-editor') as HTMLTextAreaElement | null;
  const tagsInput = $('tag-editor') as HTMLInputElement | null;
  if (!titleInput && !noteInput && !tagsInput) return;

  await knowledge.update(id, (item) => ({
    ...item,
    title: titleInput?.value.trim() || item.title,
    note: noteInput ? noteInput.value : item.note,
    tags: tagsInput ? parseTags(tagsInput.value) : item.tags,
    updatedAt: Date.now(),
  }));
  editingNoteId = null;
  render();
}

async function createNote() {
  const id = genId();
  await knowledge.put({
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
  });
  editingNoteId = id;
  currentPage = 1;
  render();
  const input = $('note-editor');
  if (input) input.focus();
}

function toast(msg: string, undoFn?: (() => unknown) | null) {
  showToast(msg, { undoFn, duration: 4000 });
}

function showConfirm(msg: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = $('confirm-overlay');
    const dialog = overlay.querySelector('.confirm-dialog');
    $('confirm-msg').textContent = msg;
    overlay.classList.remove('hidden');
    const prevFocus = document.activeElement;
    const yes = $('confirm-yes');
    const no = $('confirm-no');
    const cleanup = (result: boolean) => {
      overlay.classList.add('hidden');
      overlay.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      yes.removeEventListener('click', onYes);
      no.removeEventListener('click', onNo);
      if (prevFocus && (prevFocus as HTMLElement).focus) (prevFocus as HTMLElement).focus();
      resolve(result);
    };
    const onYes = () => cleanup(true);
    const onNo = () => cleanup(false);
    const onBackdrop = (e: Event) => {
      if (e.target === overlay) cleanup(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        cleanup(false);
        return;
      }
      if (e.key === 'Tab') {
        // 焦点陷阱：Tab/Shift+Tab 在对话框按钮间循环
        const f = dialog.querySelectorAll('button:not([disabled])');
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
      }
    };
    yes.addEventListener('click', onYes);
    no.addEventListener('click', onNo);
    overlay.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
    yes.focus();
  });
}

function typeName(id: string): string {
  return ITEM_TYPES.find((item) => item.id === id)?.name || id || '未分类';
}

function closeDocument() {
  const overlay = $('doc-overlay');
  if (!overlay || overlay.classList.contains('hidden')) return;
  overlay.classList.add('hidden');
  document.body.classList.remove('modal-open');
  if (docKeyHandler) {
    document.removeEventListener('keydown', docKeyHandler, true);
    docKeyHandler = null;
  }
  $('doc-content').innerHTML = '';
  if (docPreviousFocus && docPreviousFocus.isConnected) {
    try { docPreviousFocus.focus(); } catch (e) {}
  }
  docPreviousFocus = null;
  docItemId = '';
}

function openDocument(id: string) {
  const item = knowledge.get(id);
  if (!item) return;
  docItemId = id;
  docPreviousFocus = document.activeElement as HTMLElement | null;
  $('doc-title').textContent = item.title || '未命名文档';
  const tags = Array.isArray(item.tags) && item.tags.length ? ' · ' + item.tags.join(' / ') : '';
  $('doc-meta').textContent = typeName(item.type) + tags + ' · ' + fmtTime(item.updatedAt);
  $('doc-content').innerHTML = item.note && String(item.note).trim()
    ? renderMarkdown(String(item.note), null, false)
    : '<p class="doc-empty">这篇内容还没有正文。点击“编辑”开始写 Markdown。</p>';
  const openBtn = $('doc-open');
  openBtn.disabled = !item.url;
  openBtn.title = item.url ? item.url : '这条内容没有原文链接';
  const overlay = $('doc-overlay');
  overlay.classList.remove('hidden');
  document.body.classList.add('modal-open');
  $('doc-close').focus();
  docKeyHandler = (e: KeyboardEvent) => {
    if (!overlay.isConnected || overlay.classList.contains('hidden')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeDocument();
      return;
    }
    if (e.key !== 'Tab') return;
    const dialog = overlay.querySelector('.doc-dialog');
    const focusable = [...dialog.querySelectorAll('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')]
      .filter((el) => el.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!dialog.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  document.addEventListener('keydown', docKeyHandler, true);
}

async function bulkDelete() {
  if (selectedIds.size === 0) return;
  const count = selectedIds.size;
  const ok = await showConfirm('确定删除 ' + count + ' 项？');
  if (!ok) return;

  const backup: Record<string, KnowledgeItem> = {};
  for (const id of selectedIds) {
    const item = knowledge.get(id);
    if (item) backup[id] = { ...item, tags: item.tags.slice() };
  }
  const next = { ...knowledge.snapshot() };
  for (const id of selectedIds) {
    delete next[id];
  }
  selectedIds.clear();
  await knowledge.replace(next);
  render();
  toast(count + ' 项已删除', async () => {
    await knowledge.putMany(Object.values(backup));
    render();
    toast('已恢复');
  });
}

$('type-tabs').addEventListener('click', (e: Event) => {
  const btn = closestEl(e.target, '.type-tab');
  if (!btn) return;
  currentType = btn.dataset.type;
  currentPage = 1;
  render();
});

$('tag-filter').addEventListener('click', (e: Event) => {
  const chip = closestEl(e.target, '.tag-filter-chip');
  if (!chip) return;
  currentTag = chip.dataset.tag;
  currentPage = 1;
  render();
});

document.querySelectorAll('.stat-card').forEach((el) => {
  el.addEventListener('click', () => {
    currentStar = (el as HTMLElement).dataset.s as string;
    currentPage = 1;
    render();
  });
});

// 搜索输入添加防抖，避免频繁渲染
$('search').addEventListener('input', debounce(() => {
  currentPage = 1;
  render();
}, 200));
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('search').focus(); }
});
$('clear-filters').addEventListener('click', () => {
  currentType = 'all'; currentTag = 'all'; currentStar = 'all'; $('search').value = ''; currentPage = 1; render();
});

$('sort-select').addEventListener('change', (e: Event) => {
  sortBy = (e.target as HTMLSelectElement).value;
  currentPage = 1;
  render();
});

$('add-note-btn').addEventListener('click', createNote);

$('kb-pagination').addEventListener('click', (e: Event) => {
  const btn = closestEl(e.target, '.kb-page-btn');
  if (!btn || btn.disabled) return;
  const page = Number(btn.dataset.page);
  if (!Number.isFinite(page) || page < 1) return;
  currentPage = page;
  render();
  const list = $('list');
  if (list && list.scrollIntoView) list.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

$('doc-close').addEventListener('click', closeDocument);
$('doc-close-bottom').addEventListener('click', closeDocument);
$('doc-overlay').addEventListener('click', (e: Event) => {
  if (e.target === $('doc-overlay')) closeDocument();
});
$('doc-open').addEventListener('click', () => {
  const item = knowledge.get(docItemId);
  if (item && item.url) void tabsPort.open(item.url);
});
$('doc-edit').addEventListener('click', () => {
  const id = docItemId;
  if (!id || !knowledge.get(id)) return;
  closeDocument();
  editingNoteId = id;
  render();
  const input = $('title-editor') || $('note-editor');
  if (input) input.focus();
});
$('doc-content').addEventListener('click', (e: Event) => {
  const btn = closestEl(e.target, '.code-copy');
  if (!btn) return;
  const wrap = btn.closest('.code-wrap');
  const codeEl = wrap && wrap.querySelector('code');
  if (!codeEl) return;
  navigator.clipboard.writeText(codeEl.textContent || '').then(() => {
    btn.textContent = '已复制';
    setTimeout(() => { btn.textContent = '复制'; }, 1200);
  }).catch(() => {});
});

$('list').addEventListener('click', async (e: Event) => {
  const itemEl = closestEl(e.target, '.item');
  if (!itemEl) return;
  const id = itemEl.dataset.id;

  const cb = closestEl(e.target, '.item-select');
  if (cb) {
    toggleSelect(id);
    return;
  }

  if (closestEl(e.target, '.item-note')) {
    editingNoteId = id;
    render();
    const input = $('note-editor');
    if (input) input.focus();
    return;
  }

  const starCell = closestEl(e.target, '.star-cell[data-star]');
  if (starCell) {
    const v = Number(starCell.dataset.star);
    if (!knowledge.get(id)) return;
    await knowledge.update(id, (item) => ({ ...item, status: v, updatedAt: Date.now() }));
    renderStats();
    updateItemStar(itemEl, v);
    return;
  }

  const act = closestEl(e.target, '[data-act]');
  if (act) {
    const a = act.dataset.act;
    if (a === 'del') {
      // 与 popup 统一为「即时删除 + 强撤销」，不再二次确认（批量删除仍保留确认）
      const current = knowledge.get(id);
      if (!current) return;
      const backup = { ...current, tags: current.tags.slice() };
      const title = current.title || '此条目';
      await knowledge.remove(id);
      if (editingNoteId === id) editingNoteId = null;
      render();
      toast('已删除「' + title + '」', async () => {
        await knowledge.put(backup);
        render();
        toast('已恢复');
      });
    } else if (a === 'read') {
      openDocument(id);
    } else if (a === 'edit') {
      editingNoteId = id;
      render();
      const input = $('title-editor') || $('note-editor');
      if (input) input.focus();
    } else if (a === 'save') {
      await saveEditingItem(id);
    } else if (a === 'cancel') {
      editingNoteId = null;
      render();
    }
    return;
  }

  const item = knowledge.get(id);
  if (closestEl(e.target, '.item-title') && item) {
    if (item.url) void tabsPort.open(item.url);
    else if (item.note) openDocument(id);
  }
});

// 星级键盘可达：就地更新，避免整列表 render() 导致焦点/滚动丢失
bindStarKeyboard($('list'), (v, cell) => {
  const itemEl = cell.closest('.item');
  if (!itemEl) return;
  const id = (itemEl as HTMLElement).dataset.id as string;
  if (!knowledge.get(id)) return;
  void knowledge
    .update(id, (item) => ({ ...item, status: v, updatedAt: Date.now() }))
    .catch(() => toast('更新失败，请重试'));
  renderStats();
  const lvl = itemEl.querySelector('.level-name');
  if (lvl) lvl.outerHTML = levelNameHtml(v);
});

$('list').addEventListener('keydown', async (e: KeyboardEvent) => {
  if (e.key !== 'Enter') return;
  // 文档编辑框允许用 Enter 正常换行；Ctrl/Cmd+Enter 才是保存。
  if (e.target && (e.target as Element).tagName === 'TEXTAREA' && !(e.ctrlKey || e.metaKey)) return;
  if (!editingNoteId) return;
  await saveEditingItem(editingNoteId);
});

$('export-btn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(knowledge.snapshot(), null, 2)], {
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
function isValidImportItem(item: unknown): item is Partial<KnowledgeItem> {
  if (!item || typeof item !== 'object') return false;
  const candidate = item as Partial<KnowledgeItem>;
  if (typeof candidate.title !== 'string' || !candidate.title.trim()) return false;
  // 验证 type 是否合法
  const validTypes = ITEM_TYPES.map((t) => t.id);
  if (candidate.type && !validTypes.includes(candidate.type)) return false;
  // 验证 status 是否合法
  if (
    candidate.status !== undefined &&
    ![STATUS.GENERAL, STATUS.IMPORTANT, STATUS.FREQUENT].includes(Number(candidate.status))
  ) {
    return false;
  }
  // 验证 tags 是否为数组
  if (candidate.tags && !Array.isArray(candidate.tags)) return false;
  // 验证 url 是否为字符串
  if (candidate.url && typeof candidate.url !== 'string') return false;
  return true;
}

$('import-file').addEventListener('change', async (e: Event) => {
  const file = (e.target as HTMLInputElement).files![0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      toast('无效的 JSON 格式：应为对象');
      return;
    }

    const imported: KnowledgeItem[] = [];
    let skipped = 0;
    for (const [id, item] of Object.entries(data as Record<string, unknown>)) {
      if (isValidImportItem(item)) {
        const existing = knowledge.get(id);
        const now = Date.now();
        imported.push({
          id,
          type: item.type || existing?.type || 'wrong',
          title: String(item.title || '').trim() || existing?.title || '未命名',
          url: item.url || existing?.url || '',
          platform: item.platform || existing?.platform || '',
          platformName: item.platformName || existing?.platformName || '',
          status: item.status ?? existing?.status ?? STATUS.IMPORTANT,
          note: item.note ?? existing?.note ?? '',
          tags: item.tags ?? (existing ? existing.tags.slice() : []),
          createdAt: Number(item.createdAt) || existing?.createdAt || now,
          updatedAt: now,
        });
      } else {
        skipped++;
        logError('Skipped invalid import item', { id, item });
      }
    }
    await knowledge.putMany(imported);
    const count = imported.length;
    render();
    toast(skipped > 0 ? `已导入 ${count} 项，跳过 ${skipped} 项无效数据` : `已导入 ${count} 项`);
  } catch (err) {
    toast('导入失败：' + (err as Error).message);
    logError('Import failed', err);
  }
  (e.target as HTMLInputElement).value = '';
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
  if ((e.ctrlKey || e.metaKey) && e.key === 'a' && document.activeElement?.tagName !== 'INPUT') {
    e.preventDefault();
    filtered().forEach((it) => selectedIds.add(it.id));
    render();
  }
  // Delete 键批量删除已选项
  if (e.key === 'Delete' && selectedIds.size > 0 && document.activeElement?.tagName !== 'INPUT') {
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
  if (!knowledge.get(id)) {
    toast('未找到该条目（可能已被删除）');
    return;
  }
  // 重置筛选条件，确保目标条目可见
  currentType = 'all';
  currentTag = 'all';
  currentStar = 'all';
  $('search').value = '';
  editingNoteId = null;
  const targetIndex = filtered().findIndex((item) => item.id === id);
  currentPage = targetIndex >= 0 ? Math.floor(targetIndex / KB_PAGE_SIZE) + 1 : 1;
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
  await knowledge.load();
  renderUserscriptBadge();
  render();
  focusItemFromHash();
  knowledge.subscribe(() => {
    if (editingNoteId) return;
    render();
  });
})();

window.addEventListener('pagehide', (event) => {
  if (!event.persisted) knowledge.dispose();
});

async function renderUserscriptBadge() {
  const badge = $('us-count-badge');
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
