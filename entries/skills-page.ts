// 技能页面：渲染 + 增删改 + 分页 + 导入/导出 SKILL.md。
// 数据采用 SkillHub 标准 SKILL.md 形态（skill-store 负责持久化，skill-md 负责格式互转）。
import {
  getMergedSkills,
  addUserSkill,
  updateUserSkill,
  removeUserSkill,
  PAGE_SIZE,
} from '../lib/application/agent/skill-store.ts';
import { mdToSkill, serializeSkillMd } from '../lib/application/agent/skill-md.ts';
import { TOOL_REGISTRY, TOOL_RENAME_MAP } from '../lib/application/agent/tools.ts';

const INTENT_LABEL = {
  browser_task: '浏览器操作',
  knowledge_task: '知识库',
  research_task: '资料研究',
  chat_task: '对话',
};

/**
 * 技能条目：形状由 skill-store（SKILL.md 解析结果）决定，本页只按需读字段。
 * 这些页面脚本是 DOM 胶水层，字段集合有二十多个且随技能格式演进 —— 不在这里复制一份 schema。
 */
type Dyn = Record<string, any>;

/** 按 id 取元素：id 全部写死在 skills.html 里（取不到就是模板坏了，原代码也不做 null 检查）。 */
const $ = (id: string): any => document.getElementById(id);

/** 事件目标 → 最近的匹配元素（原代码直接 closestEl(e.target, ...)）。 */
const closestEl = (target: EventTarget | null, selector: string): any =>
  target ? (target as Element).closest(selector) : null;

let allSkills: Dyn[] = []; // 运行结构列表（含 builtin 标记）
let currentPage = 1;
let editingName: string | null = null; // null=新建，否则为待编辑技能 name
let skillQuery = '';
let skillKind = 'all';
let skillCategory = 'all';
let modalPreviousFocus: HTMLElement | null = null;

function esc(s: unknown): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function describeKeywords(skill: Dyn): string {
  const strs = skill.match && skill.match.keywordStrings;
  if (Array.isArray(strs) && strs.length) return strs.join('；');
  const kws = skill.match && skill.match.keywords;
  if (Array.isArray(kws) && kws.length) return kws.map((re) => re.source.replace(/^\(|\)$/g, '').replace(/\|/g, ' / ')).join('；');
  return '任意（按意图匹配）';
}

function describeIntents(intents: unknown): string {
  if (!Array.isArray(intents) || !intents.length) return '不限意图';
  return intents.map((i) => (INTENT_LABEL as Record<string, string>)[String(i)] || i).join('、');
}

function renderSkill(skill: Dyn): string {
  const meta = [
    skill.version ? 'v' + skill.version : '',
    skill.category || '',
    skill.skill_type || '',
  ].filter(Boolean).join(' · ');
  const tags = Array.isArray(skill.tags) && skill.tags.length
    ? `<div class="skill-tags">${skill.tags.map((t) => `<span class="skill-tag">${esc(t)}</span>`).join('')}</div>`
    : '';
  const badge = skill.builtin ? '<span class="skill-builtin-tag">内置 · 只读</span>' : '';
  const ops = skill.builtin
    ? ''
    : `<button class="skill-act" data-act="edit" data-id="${esc(skill.name)}">编辑</button>
       <button class="skill-act danger" data-act="delete" data-id="${esc(skill.name)}">删除</button>`;
  const exportBtn = `<button class="skill-act" data-act="export" data-id="${esc(skill.name)}">导出</button>`;
  const intentText = describeIntents(skill.match && skill.match.intents);
  const keywordText = describeKeywords(skill);
  return `
    <article class="skill-card" data-skill-name="${esc(skill.name)}">
      <header class="skill-head">
        <div class="skill-title-wrap">
          <h2 class="skill-title">${esc(skill.title || skill.name)}</h2>
          ${badge}
        </div>
        <div class="skill-head-actions">${exportBtn}${ops}</div>
      </header>
      <p class="skill-desc">${esc(skill.description)}</p>
      ${meta ? `<div class="skill-meta-line">${esc(meta)}</div>` : ''}
      <div class="skill-trigger-summary">
        <span class="skill-trigger-pill"><b>意图</b>${esc(intentText)}</span>
        <span class="skill-trigger-pill" title="${esc(keywordText)}"><b>关键词</b>${esc(keywordText)}</span>
      </div>
      <details class="skill-details">
        <summary>查看触发规则与正文</summary>
        <div class="skill-details-body">
          <div class="skill-meta">
            <span class="skill-meta-k">触发意图</span><span class="skill-meta-v">${esc(intentText)}</span>
            <span class="skill-meta-k">触发关键词</span><span class="skill-meta-v">${esc(keywordText)}</span>
            <span class="skill-meta-k">依赖工具</span><span class="skill-meta-v">${esc((skill.tools || []).join(', ') || '无')}</span>
          </div>
          ${tags}
          <div class="skill-block-title">正文</div>
          <pre class="skill-content-preview">${esc(skill.content || '')}</pre>
        </div>
      </details>
    </article>`;
}

function filteredSkills() {
  const q = skillQuery.trim().toLowerCase();
  return allSkills.filter((skill) => {
    if (skillKind === 'builtin' && !skill.builtin) return false;
    if (skillKind === 'custom' && skill.builtin) return false;
    if (skillCategory !== 'all' && (skill.category || '') !== skillCategory) return false;
    if (!q) return true;
    const haystack = [
      skill.name,
      skill.title,
      skill.description,
      skill.category,
      ...(skill.tags || []),
      describeIntents(skill.match && skill.match.intents),
      describeKeywords(skill),
      skill.content,
    ].join(' ').toLowerCase();
    return haystack.includes(q);
  });
}

function renderCategoryFilter() {
  const select = $('skill-category-filter');
  if (!select) return;
  const categories = [...new Set(allSkills.map((skill) => skill.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (skillCategory !== 'all' && !categories.includes(skillCategory)) skillCategory = 'all';
  select.innerHTML = '<option value="all">全部分类</option>' +
    categories.map((category) => `<option value="${esc(category)}">${esc(category)}</option>`).join('');
  select.value = skillCategory;
}

function renderPagination(totalPages: number) {
  const nav = $('skill-pagination');
  if (!nav) return;
  if (totalPages <= 1) {
    nav.innerHTML = '';
    return;
  }
  let html = `<button class="page-btn" data-page="${currentPage - 1}" ${currentPage === 1 ? 'disabled' : ''}>上一页</button>`;
  for (let p = 1; p <= totalPages; p++) {
    html += `<button class="page-btn ${p === currentPage ? 'active' : ''}" data-page="${p}">${p}</button>`;
  }
  html += `<button class="page-btn" data-page="${currentPage + 1}" ${currentPage === totalPages ? 'disabled' : ''}>下一页</button>`;
  nav.innerHTML = html;
}

function render() {
  const wrap = $('skill-list');
  if (!wrap) return;
  const count = $('skill-count');
  if (count) count.textContent = String(allSkills.length);
  const skills = filteredSkills();
  const visibleCount = $('skill-visible-count');
  if (visibleCount) visibleCount.textContent = '显示 ' + skills.length + ' / ' + allSkills.length;
  if (!skills.length) {
    const filtering = Boolean(skillQuery.trim()) || skillKind !== 'all' || skillCategory !== 'all';
    wrap.innerHTML = filtering
      ? '<div class="empty"><span class="empty-ico">⌕</span><p>没有匹配的技能</p><p class="empty-hint">试试更换关键词、来源或分类</p></div>'
      : '<div class="empty"><span class="empty-ico">🛠</span><p>还没有技能</p></div>';
    renderPagination(1);
    return;
  }
  const totalPages = Math.ceil(skills.length / PAGE_SIZE) || 1;
  if (currentPage > totalPages) currentPage = totalPages;
  const start = (currentPage - 1) * PAGE_SIZE;
  wrap.innerHTML = skills.slice(start, start + PAGE_SIZE).map(renderSkill).join('');
  renderPagination(totalPages);
}

function linesToArr(text: unknown): string[] {
  return String(text || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function skillToForm(skill: Dyn) {
  const m = skill.match || {};
  $('f-name').value = skill.name || '';
  $('f-display').value = skill.title || '';
  $('f-desc').value = skill.description || '';
  $('f-version').value = skill.version || '1.0.0';
  $('f-category').value = skill.category || '';
  $('f-tags').value = Array.isArray(skill.tags) ? skill.tags.join(', ') : '';
  $('f-type').value = skill.skill_type || 'prompt-template';
  document.querySelectorAll('.skill-checks input[type=checkbox]').forEach((cb) => {
    const box = cb as HTMLInputElement;
    box.checked = (m.intents || []).includes(box.value);
  });
  $('f-keywords').value = (m.keywordStrings || []).join('\n');
  $('f-tools').value = Array.isArray(skill.tools) ? skill.tools.join(', ') : '';
  $('f-content').value = skill.content || '';
}

function visibleOverlay() {
  return ([...document.querySelectorAll('.confirm-overlay')] as HTMLElement[]).find((overlay) => !overlay.classList.contains('hidden')) || null;
}

function openOverlay(overlay: HTMLElement | null, focusSelector?: string | null) {
  if (!overlay) return;
  modalPreviousFocus = document.activeElement as HTMLElement | null;
  overlay.classList.remove('hidden');
  document.body.classList.add('modal-open');
  const focusTarget = focusSelector ? overlay.querySelector(focusSelector) : overlay.querySelector('button:not([disabled])');
  setTimeout(() => {
    if (focusTarget && focusTarget.isConnected) (focusTarget as HTMLElement).focus();
  }, 0);
}

function closeOverlay(overlay: HTMLElement | null) {
  if (!overlay) return;
  overlay.classList.add('hidden');
  if (!visibleOverlay()) {
    document.body.classList.remove('modal-open');
    if (modalPreviousFocus && modalPreviousFocus.isConnected) {
      try { modalPreviousFocus.focus(); } catch (e) {}
    }
    modalPreviousFocus = null;
  }
}

function showFormError(message: string) {
  const error = $('skill-form-error');
  error.textContent = message;
  error.classList.remove('hidden');
}

function clearFormError() {
  const error = $('skill-form-error');
  error.textContent = '';
  error.classList.add('hidden');
}

document.addEventListener('keydown', (e) => {
  const overlay = visibleOverlay();
  if (!overlay) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    if (overlay.id === 'skill-form-overlay') closeForm();
    else closeOverlay(overlay);
    return;
  }
  if (e.key !== 'Tab') return;
  const dialog = overlay.querySelector('.confirm-dialog');
  if (!dialog) return;
  const focusable = [...dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((el) => el.getClientRects().length > 0);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!dialog.contains(document.activeElement)) {
    e.preventDefault();
    (first as HTMLElement).focus();
  } else if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    (last as HTMLElement).focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    (first as HTMLElement).focus();
  }
}, true);

function openForm(skill: Dyn | null) {
  editingName = skill ? skill.name : null;
  $('skill-form-title').textContent = skill ? '编辑技能' : '新建技能';
  skillToForm(
    skill || {
      name: '', title: '', description: '', version: '1.0.0', category: '', tags: [], skill_type: 'prompt-template',
      match: { intents: [], keywordStrings: [] }, tools: [], content: '',
    }
  );
  clearFormError();
  openOverlay($('skill-form-overlay'), '#f-name');
}

function closeForm() {
  closeOverlay($('skill-form-overlay'));
  editingName = null;
}

async function saveForm() {
  clearFormError();
  const name = $('f-name').value.trim();
  if (!name) {
    showFormError('请填写标识 name（kebab-case）。');
    $('f-name').focus();
    return;
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    showFormError('name 需为 kebab-case（小写字母/数字，连字符分隔），如 highlight-key-points。');
    $('f-name').focus();
    return;
  }
  const tools = $('f-tools').value.split(/[,\n]/).map((s: string) => s.trim()).filter(Boolean);
  // 依赖工具校验：未识别工具在运行时会被 Agent 静默忽略，保存前提示（含旧名→新名迁移）。
  const knownTools = new Set(TOOL_REGISTRY.map((t) => t.name));
  const badTools = tools.filter((tn: string) => !knownTools.has(tn));
  if (badTools.length) {
    const hint = badTools.map((tn: string) => TOOL_RENAME_MAP[tn] ? tn + ' → ' + TOOL_RENAME_MAP[tn] : tn).join('、');
    if (!confirm('依赖工具中存在未识别项：' + hint + '\n\n未识别工具在 Agent 运行时会被忽略，功能可能不完整。仍要保存吗？（可先返回修改）')) {
      return;
    }
  }
  const payload = {
    name,
    displayName: $('f-display').value.trim(),
    description: $('f-desc').value.trim(),
    version: $('f-version').value.trim() || '1.0.0',
    category: $('f-category').value.trim(),
    tags: $('f-tags').value.split(/[,\n]/).map((s: string) => s.trim()).filter(Boolean),
    skill_type: $('f-type').value,
    content: $('f-content').value,
    x: {
      intents: Array.from(document.querySelectorAll('.skill-checks input[type=checkbox]:checked')).map((cb) => (cb as HTMLInputElement).value),
      keywords: linesToArr($('f-keywords').value),
      tools,
    },
  };
  try {
    if (editingName) {
      await updateUserSkill(editingName, payload);
    } else {
      await addUserSkill(payload);
    }
    closeForm();
    await reload();
  } catch (err) {
    showFormError('保存失败：' + ((err as Error).message ? (err as Error).message : '未知错误'));
  }
}

function runtimeToStandard(skill: Dyn) {
  const m = skill.match || {};
  return {
    name: skill.name,
    displayName: skill.title,
    description: skill.description,
    version: skill.version,
    category: skill.category,
    tags: skill.tags,
    skill_type: skill.skill_type,
    content: skill.content,
    x: {
      intents: m.intents || [],
      keywords: m.keywordStrings || [],
      tools: skill.tools || [],
    },
  };
}

function exportSkill(skill: Dyn) {
  const md = serializeSkillMd(runtimeToStandard(skill));
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (skill.name || 'skill') + '.md';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

let pendingDeleteName: string | null = null;
function askDelete(name: string) {
  pendingDeleteName = name;
  const skill = allSkills.find((s) => s.name === name);
  $('skill-del-msg').textContent = '确定删除技能「' + (skill ? skill.title || skill.name : name) + '」？此操作不可撤销。';
  openOverlay($('skill-del-overlay'), '#skill-del-no');
}

async function confirmDelete() {
  if (pendingDeleteName) await removeUserSkill(pendingDeleteName);
  pendingDeleteName = null;
  closeOverlay($('skill-del-overlay'));
  await reload();
}

async function runImport(text: string) {
  const msg = $('import-msg');
  const skill = mdToSkill(text);
  if (!skill.name) {
    msg.textContent = '解析失败：SKILL.md 缺少必需的 name 字段。';
    msg.classList.remove('hidden');
    return;
  }
  const existing = allSkills.find((s) => s.name === skill.name);
  if (existing && existing.builtin) {
    msg.textContent = '「' + skill.name + '」与内置技能重名，请修改 name 后重试。';
    msg.classList.remove('hidden');
    return;
  }
  if (existing) await updateUserSkill(skill.name, skill);
  else await addUserSkill(skill);
  msg.textContent = '已导入：' + skill.name + (existing ? '（已覆盖同名自定义技能）' : '');
  msg.classList.remove('hidden');
  await reload();
}

async function reload() {
  allSkills = await getMergedSkills();
  renderCategoryFilter();
  render();
}

function init() {
  $('new-skill-btn').addEventListener('click', () => openForm(null));
  $('skill-form-cancel').addEventListener('click', closeForm);
  $('skill-form-save').addEventListener('click', saveForm);
  $('skill-del-no').addEventListener('click', () => {
    pendingDeleteName = null;
    closeOverlay($('skill-del-overlay'));
  });
  $('skill-del-yes').addEventListener('click', confirmDelete);
  ['skill-form-overlay', 'skill-del-overlay'].forEach((id) => {
    const overlay = $(id);
    overlay.addEventListener('click', (e: Event) => {
      if (e.target !== overlay) return;
      if (id === 'skill-form-overlay') closeForm();
      else closeOverlay(overlay);
    });
  });

  $('skill-search').addEventListener('input', (e: Event) => {
    skillQuery = (e.target as HTMLInputElement).value;
    currentPage = 1;
    render();
  });
  $('skill-kind-filters').addEventListener('click', (e: Event) => {
    const chip = closestEl(e.target, '[data-kind]');
    if (!chip) return;
    skillKind = chip.dataset.kind;
    currentPage = 1;
    document.querySelectorAll('#skill-kind-filters [data-kind]').forEach((button) => {
      const active = button === chip;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    render();
  });
  $('skill-category-filter').addEventListener('change', (e: Event) => {
    skillCategory = (e.target as HTMLSelectElement).value;
    currentPage = 1;
    render();
  });

  $('import-toggle').addEventListener('click', () => {
    $('import-section').classList.toggle('hidden');
  });
  $('import-run').addEventListener('click', () => {
    const text = $('import-textarea').value;
    if (!text.trim()) {
      const msg = $('import-msg');
      msg.textContent = '请粘贴 SKILL.md 文本或选择文件。';
      msg.classList.remove('hidden');
      return;
    }
    runImport(text);
  });
  $('import-file').addEventListener('change', (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      $('import-textarea').value = String(reader.result || '');
    };
    reader.readAsText(file);
  });

  $('skill-list').addEventListener('click', (e: Event) => {
    const btn = closestEl(e.target, '.skill-act');
    if (!btn) return;
    const id = btn.dataset.id;
    const skill = allSkills.find((s) => s.name === id);
    if (!skill) return;
    if (btn.dataset.act === 'edit') openForm(skill);
    else if (btn.dataset.act === 'delete') askDelete(id);
    else if (btn.dataset.act === 'export') exportSkill(skill);
  });

  $('skill-pagination').addEventListener('click', (e: Event) => {
    const btn = closestEl(e.target, '.page-btn');
    if (!btn || btn.disabled) return;
    const p = Number(btn.dataset.page);
    if (Number.isFinite(p) && p >= 1) {
      currentPage = p;
      render();
    }
  });

  reload();
}

init();
