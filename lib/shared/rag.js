// RAG 检索与 AI 消息构建：把知识库条目转化为上下文与引用元数据
import { STAR_LEVELS } from './constants.js';
import { typeInfo } from './utils.js';
import { normalizeHistory } from '../assistant/context.js';

export function tokenizeQuery(query) {
  const raw = String(query || '').toLowerCase();
  const segments = raw
    .split(/[\s,，。;；:：!！?？、/\\()[\]{}<>"'`~#@$%^&*+=|]+/)
    .filter((s) => s.length);
  const tokens = [];
  for (const seg of segments) {
    if (seg.length <= 4) {
      tokens.push(seg);
    } else {
      for (let i = 0; i < seg.length - 1; i++) {
        tokens.push(seg.slice(i, i + 2));
      }
    }
  }
  return tokens;
}

export function isKbOverviewQuery(q) {
  const s = String(q || '').toLowerCase();
  return /知识库/.test(s) && /有什么|有哪些|内容|都有|全部|列出|list|看看|查看|里面|总结|汇总|概览/.test(s);
}

export function buildKbOverview(book, limit) {
  const items = Object.values(book).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const shown = items.slice(0, limit || 30);
  const total = items.length;
  const lines = shown.map((it, i) => {
    const parts = [`[${i + 1}] 标题：${it.title || '未命名'}`];
    parts.push(`类型：${typeInfo(it.type).name}`);
    if (it.status) parts.push(`星级：${(STAR_LEVELS[it.status] || {}).name || it.status}`);
    if (Array.isArray(it.tags) && it.tags.length) parts.push(`标签：${it.tags.join('、')}`);
    if (it.note) parts.push(`内容：${String(it.note).slice(0, 120)}`);
    return parts.join('｜');
  });
  return (
    '用户个人知识库共 ' +
    total +
    ' 条记录' +
    (total > shown.length ? '（以下仅列出最近 ' + shown.length + ' 条，其余未列出）' : '') +
    '：\n' +
    lines.join('\n')
  );
}

/**
 * 构建 RAG 上下文，返回匹配的条目数组
 * 采用字段加权评分：标题权重最高，标签次之，备注最低，提升检索相关性
 * @param {Object} book - 知识库数据
 * @param {string} query - 查询文本
 * @param {number} limit - 最大返回数量
 * @returns {Array} 匹配的条目数组
 */
export function buildRagContext(book, query, limit) {
  const terms = tokenizeQuery(query);
  if (!terms.length) return [];

  // 字段权重：标题最重要，标签次之，备注与类型较低
  const WEIGHTS = { title: 3, tags: 2, note: 1, type: 0.5, platform: 0.5 };

  const scored = Object.values(book).map((it) => {
    const titleLow = (it.title || '').toLowerCase();
    const noteLow = (it.note || '').toLowerCase();
    const tagsLow = (it.tags || []).join(' ').toLowerCase();
    const typeLow = (it.type || '').toLowerCase();
    const platformLow = (it.platformName || '').toLowerCase();

    let score = 0;
    const matched = new Set();
    for (const t of terms) {
      if (titleLow.includes(t)) {
        score += WEIGHTS.title;
        matched.add(t);
      }
      if (tagsLow.includes(t)) {
        score += WEIGHTS.tags;
        matched.add(t);
      }
      if (noteLow.includes(t)) {
        score += WEIGHTS.note;
        matched.add(t);
      }
      if (typeLow.includes(t)) score += WEIGHTS.type;
      if (platformLow.includes(t)) score += WEIGHTS.platform;
    }
    // 覆盖度奖励：命中的不同查询词越多，相关性越高
    if (matched.size > 1) score += matched.size * 0.5;
    return { it, score };
  });

  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit || 5)
    .map((x) => x.it);
}

/**
 * 构建引用来源元数据，用于前端渲染引用卡片
 * @param {Array} relevantItems - RAG 检索到的条目
 * @param {boolean} isOverview - 是否为知识库概览查询
 * @returns {Array|null} 引用元数据数组 [{index, id, title, type, url}]
 */
export function buildCitations(relevantItems, isOverview) {
  if (!relevantItems || !relevantItems.length) return null;
  return relevantItems.map((it, i) => ({
    index: i + 1,
    source: 'kb',
    id: it.id,
    title: it.title || '未命名',
    type: it.type || 'wrong',
    url: it.url || '',
    snippet: it.note ? String(it.note).slice(0, 180) : String(it.title || '').slice(0, 180),
    isOverview: !!isOverview,
  }));
}

export function buildAiMessages(action, payload, settings, book) {
  const text = payload.text || '';

  if (action === 'translate') {
    const t = payload.targetLang || settings.targetLang || '中文';
    return [
      { role: 'system', content: '你是一名专业翻译。只输出译文，不要任何解释或额外内容。' },
      { role: 'user', content: '请将以下内容翻译成' + t + '：\n\n' + text },
    ];
  }
  if (action === 'explain') {
    return [
      { role: 'system', content: '你是一名耐心的讲解者，用通俗易懂的中文解释概念，可用 Markdown 排版。' },
      { role: 'user', content: '请解释以下内容：\n\n' + text },
    ];
  }
  if (action === 'summarize') {
    return [
      { role: 'system', content: '你是总结助手，输出简洁的中文要点总结，用 Markdown 列表排版。' },
      { role: 'user', content: '请总结以下内容的要点：\n\n' + text },
    ];
  }
  if (action === 'ask') {
    const question = payload.question || text || '';
    let ctx = '';
    let citations = null;
    if (settings.ragEnabled) {
      if (isKbOverviewQuery(question || text)) {
        ctx = buildKbOverview(book, 30);
        citations = buildCitations(Object.values(book).slice(0, 30), true);
      } else {
        const relevant = buildRagContext(book, question || text, 5);
        if (relevant.length) {
          citations = buildCitations(relevant, false);
          ctx =
            '以下是从用户个人知识库中检索到的相关条目，请优先参考它们回答：\n' +
            relevant
              .map((it, i) => {
                const parts = [`[${i + 1}] 标题：${it.title}`, `类型：${typeInfo(it.type).name}`];
                if (it.note) parts.push('内容/备注：' + it.note);
                if (it.url) parts.push('链接：' + it.url);
                return parts.join('\n');
              })
              .join('\n\n');
        }
      }
    }
    const messages = [
      {
        role: 'system',
        content:
          '你是用户的个人知识库助手。请用中文回答，可用 Markdown 排版。若提供了知识库上下文，请基于它回答，并在引用具体条目时使用 [n] 格式标注来源编号（n 为条目编号）；若无相关知识，请明确说明并给出通用回答。',
      },
      {
        role: 'user',
        content:
          '问题：' +
          question +
          (text ? '\n\n选中的文本：\n' + text : '') +
          (ctx ? '\n\n知识库上下文：\n' + ctx : ''),
      },
    ];
    // 附加引用元数据到 messages 对象（非标准字段，供调用方使用）
    messages._citations = citations;
    return messages;
  }
  if (action === 'command') {
    const instruction = payload.question || payload.command || '';
    const page = payload.page || '';
    const history = normalizeHistory(payload.history, { maxMessages: 10, maxChars: 3000, maxTokens: 8000 });
    let ctx = '';
    let citations = null;
    if (settings.ragEnabled) {
      if (isKbOverviewQuery(instruction || text)) {
        ctx = buildKbOverview(book, 30);
        citations = buildCitations(Object.values(book).slice(0, 30), true);
      } else {
        const relevant = buildRagContext(book, instruction || text, 5);
        if (relevant.length) {
          citations = buildCitations(relevant, false);
          ctx =
            '以下是从用户个人知识库中检索到的相关条目，可参考（引用时请使用 [n] 格式标注来源编号）：\n' +
            relevant
              .map((it, i) => `[${i + 1}] 标题：${it.title}｜类型：${typeInfo(it.type).name}${it.note ? '｜内容：' + it.note : ''}`)
              .join('\n');
        }
      }
    }
    const hasText = !!text;
    const userParts = [];
    if (hasText) userParts.push('选中的文本：\n' + text);
    if (page) userParts.push('当前页面的完整内容（作为背景上下文，回答时请结合整页内容，而不只限于选中文本）：\n' + page);
    if (ctx) userParts.push('知识库上下文（供参考，可选用）：\n' + ctx);
    if (instruction) userParts.push('用户指令：\n' + instruction);
    if (!hasText && !instruction) userParts.push('（无输入）');
    const messages = [
      {
        role: 'system',
        content:
          '你是一个强大的 AI 助手，能执行用户的各种指令：翻译、改写、解释、总结、生成代码、润色文档等。回答时应结合上下文。引用编号只发给**可打开的来源**（知识库条目、第三方网页）；**页面内容属于当前上下文，不要为它标引用编号**，也不要自造 [页面]、[本页] 这类标签 —— 括号里没有数字就抽不出编号，不会生成可点击来源，只会留下看着像引用、点了却没反应的死文本。请严格按指令执行，输出清晰结果。可使用 Markdown 排版。',
      },
    ];
    for (const h of history) {
      messages.push({ role: h.role, content: h.content });
    }
    messages.push({ role: 'user', content: userParts.join('\n\n') });
    // 附加引用元数据到 messages 对象（非标准字段，供调用方使用）
    messages._citations = citations;
    return messages;
  }
  if (action === 'complete') {
    const before = payload.text || payload.before || '';
    const after = payload.after || '';
    const language = payload.language || '代码/文本';
    return [
      {
        role: 'system',
        content:
          '你是代码与文档补全助手。只输出光标位置的续写内容，不要重复已有的文本，不要解释，不要输出完整前后文，只给出紧跟光标之后的补全片段（与上下文衔接自然）。',
      },
      {
        role: 'user',
        content:
          '当前语言/场景：' +
          language +
          '\n光标之前的文本：\n' +
          before +
          (after ? '\n\n光标之后的文本（参考）：\n' + after : '') +
          '\n\n请直接输出光标之后的补全内容：',
      },
    ];
  }
  return null;
}
