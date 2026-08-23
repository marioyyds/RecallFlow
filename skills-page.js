// 技能页面：渲染 + 增删改 + 分页 + 导入/导出 SKILL.md。
// 数据采用 SkillHub 标准 SKILL.md 形态（skill-store 负责持久化，skill-md 负责格式互转）。
import {
  getMergedSkills,
  addUserSkill,
  updateUserSkill,
  removeUserSkill,
  PAGE_SIZE,
} from './lib/assistant/skill-store.js';
import { mdToSkill, serializeSkillMd } from './lib/assistant/skill-md.js';

const INTENT_LABEL = {
  browser_task: '浏览器操作',
  knowledge_task: '知识库',
  research_task: '资料研究',
  chat_task: '对话',
};

let allSkills = []; // 运行结构列表（含 builtin 标记）
let currentPage = 1;
let editingName = null; // null=新建，否则为待编辑技能 name

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function describeKeywords(skill) {
  const strs = skill.match && skill.match.keywordStrings;
  if (Array.isArray(strs) && strs.length) return strs.join('；');
  const kws = skill.match && skill.match.keywords;
  if (Array.isArray(kws) && kws.length) return kws.map((re) => re.source.replace(/^\(|\)$/g, '').replace(/\|/g, ' / ')).join('；');
  return '任意（按意图匹配）';
}

function describeIntents(intents) {
  if (!Array.isArray(intents) || !intents.length) return '不限意图';
  return intents.map((i) => INTENT_LABEL[i] || i).join('、');
}

function renderSkill(skill) {
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
  return `
    <article class="skill-card">
      <header class="skill-head">
        <div class="skill-title-wrap">
          <h2 class="skill-title">${esc(skill.title || skill.name)}</h2>
          ${badge}
        </div>
        <div class="skill-head-actions">${exportBtn}${ops}</div>
      </header>
      <p class="skill-desc">${esc(skill.description)}</p>
      ${meta ? `<div class="skill-meta-line">${esc(meta)}</div>` : ''}
      ${tags}
      <div class="skill-meta">
        <span class="skill-meta-k">触发意图</span><span class="skill-meta-v">${describeIntents(skill.match && skill.match.intents)}</span>
        <span class="skill-meta-k">触发关键词</span><span class="skill-meta-v">${esc(describeKeywords(skill))}</span>
      </div>
      <div class="skill-content-preview">${esc(skill.content || '')}</div>
    </article>`;
}

function renderPagination(totalPages) {
  const nav = document.getElementById('skill-pagination');
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
  const wrap = document.getElementById('skill-list');
  if (!wrap) return;
  const count = document.getElementById('skill-count');
  if (count) count.textContent = String(allSkills.length);
  if (!allSkills.length) {
    wrap.innerHTML = '<div class="empty"><span class="empty-ico">🛠</span><p>还没有技能</p></div>';
    renderPagination(1);
    return;
  }
  const totalPages = Math.ceil(allSkills.length / PAGE_SIZE) || 1;
  if (currentPage > totalPages) currentPage = totalPages;
  const start = (currentPage - 1) * PAGE_SIZE;
  wrap.innerHTML = allSkills.slice(start, start + PAGE_SIZE).map(renderSkill).join('');
  renderPagination(totalPages);
}

function linesToArr(text) {
  return String(text || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function skillToForm(skill) {
  const m = skill.match || {};
  document.getElementById('f-name').value = skill.name || '';
  document.getElementById('f-display').value = skill.title || '';
  document.getElementById('f-desc').value = skill.description || '';
  document.getElementById('f-version').value = skill.version || '1.0.0';
  document.getElementById('f-category').value = skill.category || '';
  document.getElementById('f-tags').value = Array.isArray(skill.tags) ? skill.tags.join(', ') : '';
  document.getElementById('f-type').value = skill.skill_type || 'prompt-template';
  document.querySelectorAll('.skill-checks input[type=checkbox]').forEach((cb) => {
    cb.checked = (m.intents || []).includes(cb.value);
  });
  document.getElementById('f-keywords').value = (m.keywordStrings || []).join('\n');
  document.getElementById('f-tools').value = Array.isArray(skill.tools) ? skill.tools.join(', ') : '';
  document.getElementById('f-content').value = skill.content || '';
}

function openForm(skill) {
  editingName = skill ? skill.name : null;
  document.getElementById('skill-form-title').textContent = skill ? '编辑技能' : '新建技能';
  skillToForm(
    skill || {
      name: '', title: '', description: '', version: '1.0.0', category: '', tags: [], skill_type: 'prompt-template',
      match: { intents: [], keywordStrings: [] }, tools: [], content: '',
    }
  );
  document.getElementById('skill-form-overlay').classList.remove('hidden');
}

function closeForm() {
  document.getElementById('skill-form-overlay').classList.add('hidden');
  editingName = null;
}

async function saveForm() {
  const name = document.getElementById('f-name').value.trim();
  if (!name) {
    alert('请填写标识 name（kebab-case）');
    return;
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    alert('name 需为 kebab-case（小写字母/数字，连字符分隔），如 highlight-key-points');
    return;
  }
  const payload = {
    name,
    displayName: document.getElementById('f-display').value.trim(),
    description: document.getElementById('f-desc').value.trim(),
    version: document.getElementById('f-version').value.trim() || '1.0.0',
    category: document.getElementById('f-category').value.trim(),
    tags: document.getElementById('f-tags').value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean),
    skill_type: document.getElementById('f-type').value,
    content: document.getElementById('f-content').value,
    x: {
      intents: Array.from(document.querySelectorAll('.skill-checks input[type=checkbox]:checked')).map((cb) => cb.value),
      keywords: linesToArr(document.getElementById('f-keywords').value),
      tools: document.getElementById('f-tools').value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean),
    },
  };
  if (editingName) {
    await updateUserSkill(editingName, payload);
  } else {
    await addUserSkill(payload);
  }
  closeForm();
  await reload();
}

function runtimeToStandard(skill) {
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

function exportSkill(skill) {
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

let pendingDeleteName = null;
function askDelete(name) {
  pendingDeleteName = name;
  const skill = allSkills.find((s) => s.name === name);
  document.getElementById('skill-del-msg').textContent = '确定删除技能「' + (skill ? skill.title || skill.name : name) + '」？此操作不可撤销。';
  document.getElementById('skill-del-overlay').classList.remove('hidden');
}

async function confirmDelete() {
  if (pendingDeleteName) await removeUserSkill(pendingDeleteName);
  pendingDeleteName = null;
  document.getElementById('skill-del-overlay').classList.add('hidden');
  await reload();
}

async function runImport(text) {
  const msg = document.getElementById('import-msg');
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
  render();
}

function init() {
  document.getElementById('new-skill-btn').addEventListener('click', () => openForm(null));
  document.getElementById('skill-form-cancel').addEventListener('click', closeForm);
  document.getElementById('skill-form-save').addEventListener('click', saveForm);
  document.getElementById('skill-del-no').addEventListener('click', () => {
    pendingDeleteName = null;
    document.getElementById('skill-del-overlay').classList.add('hidden');
  });
  document.getElementById('skill-del-yes').addEventListener('click', confirmDelete);

  document.getElementById('import-toggle').addEventListener('click', () => {
    document.getElementById('import-section').classList.toggle('hidden');
  });
  document.getElementById('import-run').addEventListener('click', () => {
    const text = document.getElementById('import-textarea').value;
    if (!text.trim()) {
      const msg = document.getElementById('import-msg');
      msg.textContent = '请粘贴 SKILL.md 文本或选择文件。';
      msg.classList.remove('hidden');
      return;
    }
    runImport(text);
  });
  document.getElementById('import-file').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      document.getElementById('import-textarea').value = String(reader.result || '');
    };
    reader.readAsText(file);
  });

  document.getElementById('skill-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.skill-act');
    if (!btn) return;
    const id = btn.dataset.id;
    const skill = allSkills.find((s) => s.name === id);
    if (!skill) return;
    if (btn.dataset.act === 'edit') openForm(skill);
    else if (btn.dataset.act === 'delete') askDelete(id);
    else if (btn.dataset.act === 'export') exportSkill(skill);
  });

  document.getElementById('skill-pagination').addEventListener('click', (e) => {
    const btn = e.target.closest('.page-btn');
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
