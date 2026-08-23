// 最小化 SKILL.md 解析/序列化（仅支持 SkillHub 用到的 frontmatter 子集，不引入外部依赖）。
// 标准形态：---<yaml frontmatter>---\n<markdown 正文>
// 我们把 RecallFlow 专有的触发条件放在 x-recallflow-* 扩展字段（符合 SkillHub 的 x- 前缀约定）。
// 注意：本文件不依赖 skill-store，避免循环引用（skill-store 反而依赖本文件）。

// 把用户输入的一组关键词（"词1|词2"）转成安全的正则（转义正则元字符）。
function compileKeywords(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (item instanceof RegExp) {
      out.push(item);
      continue;
    }
    const src = String(item || '').trim();
    if (!src) continue;
    const group = src
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    if (group) out.push(new RegExp(group));
  }
  return out;
}

function parseScalar(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (s === '' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

// 解析 SKILL.md 文本 -> { data: frontmatter 对象, body: markdown 正文 }
export function parseSkillMd(text) {
  const str = String(text || '');
  const m = str.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
  if (!m) {
    // 无 frontmatter：整段作为正文（name 由调用方补全）
    return { data: {}, body: str.trim() };
  }
  const fm = m[1];
  const body = m[2].replace(/\s+$/, '');
  const data = {};
  let curKey = null;
  for (const line of fm.split(/\r?\n/)) {
    if (/^\s*-\s+/.test(line) && curKey) {
      const val = parseScalar(line.replace(/^\s*-\s+/, ''));
      if (!Array.isArray(data[curKey])) data[curKey] = [];
      data[curKey].push(val);
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (kv) {
      curKey = kv[1];
      const v = kv[2].trim();
      data[curKey] = v === '' ? [] : parseScalar(v);
    }
  }
  return { data, body };
}

// 序列化技能对象 -> 标准 SKILL.md 文本
export function serializeSkillMd(skill) {
  const lines = ['---'];
  const add = (k, v) => {
    if (v === undefined || v === null || v === '') return;
    if (Array.isArray(v)) {
      if (!v.length) return;
      lines.push(k + ':');
      for (const it of v) lines.push('  - ' + String(it));
    } else if (typeof v === 'boolean' || typeof v === 'number') {
      lines.push(k + ': ' + v);
    } else {
      lines.push(k + ': ' + String(v));
    }
  };
  add('name', skill.name);
  add('description', skill.description);
  if (skill.version) add('version', skill.version);
  if (skill.category) add('category', skill.category);
  if (Array.isArray(skill.tags) && skill.tags.length) add('tags', skill.tags);
  if (skill.skill_type) add('skill_type', skill.skill_type);
  const x = skill.x || {};
  if (x.intents && x.intents.length) add('x-recallflow-intents', x.intents);
  if (x.keywords && x.keywords.length) add('x-recallflow-keywords', x.keywords);
  if (x.tools && x.tools.length) add('x-recallflow-tools', x.tools);
  lines.push('---', '', skill.content || '');
  return lines.join('\n');
}

// 把 SKILL.md 解析结果（data + body）转为 RecallFlow 内部标准技能对象
export function mdToSkill(text) {
  const { data, body } = parseSkillMd(text);
  const x = {
    intents: Array.isArray(data['x-recallflow-intents']) ? data['x-recallflow-intents'] : [],
    keywords: Array.isArray(data['x-recallflow-keywords']) ? data['x-recallflow-keywords'] : [],
    tools: Array.isArray(data['x-recallflow-tools']) ? data['x-recallflow-tools'] : [],
  };
  return {
    name: typeof (data.name || data.slug) === 'string' ? String(data.name || data.slug) : '',
    displayName: typeof data['x-recallflow-display-name'] === 'string' ? data['x-recallflow-display-name'] : '',
    description: typeof (data.description || data.summary) === 'string' ? String(data.description || data.summary) : '',
    version: typeof data.version === 'string' ? data.version : '1.0.0',
    category: typeof data.category === 'string' ? data.category : '',
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    skill_type: typeof data.skill_type === 'string' ? data.skill_type : 'prompt-template',
    content: body,
    x,
  };
}

// 供运行期使用：把内部标准技能对象编译为带正则关键词的运行结构
export function toRuntimeSkill(skill, builtin = false) {
  const x = skill.x || {};
  const keywordStrings = Array.isArray(x.keywords) ? x.keywords.map(String) : [];
  return {
    id: skill.name || ('custom-' + Date.now().toString(36)),
    name: skill.name || '',
    title: skill.displayName || skill.name || '未命名技能',
    description: skill.description || '',
    version: skill.version || '1.0.0',
    category: skill.category || '',
    tags: Array.isArray(skill.tags) ? skill.tags : [],
    skill_type: skill.skill_type || 'prompt-template',
    content: skill.content || '',
    match: {
      intents: Array.isArray(x.intents) ? x.intents : [],
      keywords: compileKeywords(keywordStrings),
      keywordStrings,
    },
    tools: Array.isArray(x.tools) ? x.tools : [],
    builtin: !!builtin,
  };
}
