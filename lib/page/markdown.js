// 纯字符串渲染层：Markdown → HTML、代码高亮、引用徽章与深链。
//
// 为什么单独成模块：这一层把**页面文本与模型输出**拼成要注入 DOM 的 HTML，
// 是 XSS 风险面所在，也是最该被测的逻辑。原先埋在 chat.js（2900+ 行）里且零测试，
// 无法在 node 中验证。本模块不依赖 DOM，可直接单测。
//
// 注意：所有来自页面/模型的内容都必须经 escHtml 转义后再拼接。
const HL_KEYWORDS = new Set(
  'function return if else for while do switch case break continue default new class extends super this const let var typeof instanceof in of try catch finally throw async await yield import export from as static get set null undefined true false void delete package private protected public interface type enum namespace module def elif lambda pass None True False and or not global raise with assert import print del class return if elif else'.split(' ')
);
const HL_TYPES = new Set('String Number Boolean Array Object Function Promise Error Date RegExp Map Set Symbol BigInt Math JSON Console Node Buffer parseInt parseFloat isNaN isFinite JSON.stringify JSON.parse'.split(' '));

export function hlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 简单分块高亮：注释 / 字符串 / 关键字 / 数字 / 函数名 / 类型
export function highlightCode(code) {
  const esc = hlEscape(code);
  const tokens = [];

  // 组合正则，一次遍历
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(\d+\.\d+|\d+\.?)\b|([A-Za-z_$][\w$]*)/g;
  let last = 0;
  let m;
  while ((m = re.exec(esc))) {
    if (m.index > last) tokens.push(esc.slice(last, m.index));
    if (m[1]) tokens.push('<span class="tk-comment">' + m[1] + '</span>');
    else if (m[2]) tokens.push('<span class="tk-string">' + m[2] + '</span>');
    else if (m[3]) tokens.push('<span class="tk-number">' + m[3] + '</span>');
    else if (m[4]) {
      const w = m[4];
      if (HL_KEYWORDS.has(w)) tokens.push('<span class="tk-keyword">' + w + '</span>');
      else if (HL_TYPES.has(w)) tokens.push('<span class="tk-type">' + w + '</span>');
      else {
        // 函数名：后面紧跟 (
        const after = esc.slice(m.index + w.length, m.index + w.length + 1);
        if (after === '(') tokens.push('<span class="tk-fn">' + w + '</span>');
        else tokens.push(w);
      }
    }
    last = m.index + m[0].length;
  }
  if (last < esc.length) tokens.push(esc.slice(last));
  return tokens.join('');
}

/**
 * 链接地址安全化（安全原语，单独导出以便直测）。
 *
 * 为什么必须做：这一层的输入是**模型输出与页面文本**，而提示注入可以让页面把
 * 恶意链接「喂」给模型再回显出来；面板又注入在页面里，shadow DOM **不隔离脚本**，
 * 因此注入的 onclick/onmouseover 会真实执行，`javascript:` 链接点击即执行。
 *
 * 规则：只放行 http/https/mailto/tel 与相对路径；可执行协议一律拒绝。
 * 做判定前先剔除控制字符与空白，避免 `java\tscript:` 这类绕过。
 * @returns {string} 安全地址；危险时返回 ''（调用方应只保留文字、不生成链接）
 */
export function sanitizeHref(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!s) return '';
  const compact = s.replace(/[\u0000-\u0020\u007f]+/g, '');
  if (!compact) return '';
  // 可执行 / 本地协议：直接拒绝
  if (/^(?:javascript|data|vbscript|file|blob):/i.test(compact)) return '';
  // 带协议但不是白名单里的：拒绝（相对路径没有协议，放行）
  if (/^[a-z][a-z0-9+.-]*:/i.test(compact) && !/^(?:https?|mailto|tel):/i.test(compact)) return '';
  return s;
}

/**
 * 决定「点击引用」应当做什么（纯函数：安全策略集中在此，便于直测）。
 *
 * url 来自 data-cite-url，是**页面/模型可控的不可信数据**。两个易错点：
 *  - `new URL('javascript:…')` 能正常解析，所以「同页判定」挡不住它；
 *  - `data:text/html,…` 是能被 window.open 打开并展示钓鱼页的。
 * 因此必须显式校验协议后才允许打开。
 *
 * @param {string} url 引用里的链接
 * @param {string} currentHref 当前页面地址（用于同页判定与相对路径解析）
 * @param {string} [snippet] 证据片段（用于深链高亮）
 * @returns {{action:'highlight'|'open'|'deny'|'none', target?:string, reason?:string}}
 */
export function planCitationOpen(url, currentHref, snippet) {
  const raw = String(url === undefined || url === null ? '' : url).trim();
  if (!raw) return { action: 'none' };
  let samePage = false;
  try {
    const u = new URL(raw, currentHref);
    const cur = new URL(currentHref);
    samePage = u.origin === cur.origin && u.pathname === cur.pathname;
  } catch (e) {
    samePage = false;
  }
  if (samePage) return { action: 'highlight' };
  const safe = sanitizeHref(raw);
  if (!safe) {
    return { action: 'deny', reason: '该引用的链接协议不被允许（仅支持 http/https、mailto、tel），已阻止打开。' };
  }
  return { action: 'open', target: attachSnippetParam(buildCitationDeepLink(safe, snippet), snippet) };
}

/**
 * 解析模型输出里的「可选操作」建议（纯函数，便于直测）。
 *
 * 支持两种协议，模型两种都可能给：
 *  1. `<options>[{"label":"…","desc":"…"}]</options>` —— 结构化，优先
 *  2. 正文末尾的「【可选操作】」列表：`- 【标签】说明`
 * 结构化形式解析为空时**回退**到列表形式（模型常常混用）。
 *
 * 结果最多 4 条：这决定面板底部出现几个按钮，过多会挤占输入区。
 * @returns {Array<{label:string, desc:string}>}
 */
export function parseSuggestionOptions(text) {
  const out = [];
  const blockMatch = String(text || '').match(/<options>([\s\S]*?)<\/options>/i);
  if (blockMatch) {
    try {
      const arr = JSON.parse(blockMatch[1].trim());
      if (Array.isArray(arr)) {
        arr.slice(0, 4).forEach((it) => {
          const label = String((it && it.label) || '').trim();
          const desc = String((it && it.desc) || '').trim();
          if (label) out.push({ label, desc });
        });
        if (out.length) return out;
      }
    } catch (e) {}
  }
  const match = String(text || '').match(/【可选操作】([\s\S]*)$/);
  const section = match ? match[1] : '';
  const re = /(?:^|\n)\s*(?:[-*]|\d+[.、])\s*【([^】\n]{1,12})】\s*([^\n]*)/g;
  let m;
  while ((m = re.exec(section)) && out.length < 4) {
    const label = m[1].trim();
    const desc = m[2].trim();
    if (label) out.push({ label, desc });
  }
  return out;
}

// ---- Markdown 渲染 ----
// citations：可选，传入引用元数据数组后，[n] 会渲染为可点击的引用徽章
// streaming：是否处于流式输出中（为 true 时末尾追加闪烁光标）
export function renderMarkdown(md, citations, streaming) {
  const lines = md.split('\n');
  let html = '';
  let inCode = false;
  let codeBuf = [];
  let codeLang = '';
  let listType = null;
  let tableBuf = null;

  const escInline = (s) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  const escAttr = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

  const inline = (s) => {
    let r = escInline(s);
    r = r.replace(/`([^`]+)`/g, '<code>$1</code>');
    r = r.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    r = r.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
    r = r.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, hrefRaw) => {
      const href = sanitizeHref(hrefRaw);
      if (!href) return text; // 危险协议：只保留文字，不生成可点击链接
      // 注意：hrefRaw 已由 escInline 转过 & < >，这里只需补上它漏掉的引号转义，
      // 否则会把 & 二次转义成 &amp;amp; 从而破坏 URL。
      return '<a href="' + href.replace(/"/g, '&quot;') + '" target="_blank" rel="noopener noreferrer">' + text + '</a>';
    });
    // 将 [n]（或 [标签n] 如 [K8s文档2]）渲染为可点击的引用徽章（仅当存在引用元数据时）。
    // 容错匹配「括号内以数字结尾」的形式，提取数字对齐全局引用编号。
    if (citations && citations.length) {
      r = r.replace(/[\uFF3B\u005B]([^\]]*?)[\uFF3D\u005D]/g, (match, inner) => {
        const idx = extractCiteNum(inner);
        if (idx === null) return match;
        // 按「位置」对齐参考来源区（body [n] → 来源区第 n 条），与重编号后的顺序完全一致。
        const c = citations[idx - 1];
        if (!c) return match;
        const short = c.title.length > 16 ? c.title.slice(0, 16) + '…' : c.title;
        return (
          '<button class="cite-badge" data-cite-id="' + escAttr(c.id || '') + '" data-cite-source="' + escAttr(c.source || 'kb') + '" data-cite-url="' + escAttr(c.url || '') + '" data-cite-snippet="' + escAttr(c.snippet || '') + '" title="打开证据：' + escAttr(c.title) + '">' +
          '<span class="cite-idx">[' + idx + ']</span>' + escAttr(short) + '</button>'
        );
      });
    }
    return r;
  };

  const flushList = () => {
    if (listType) {
      html += '</' + listType + '>';
      listType = null;
    }
  };

  const isTableSep = (l) => /^\s*\|?[\s:\-|]+\|?\s*$/.test(l) && l.includes('-') && l.includes('|');
  const parseRow = (r) => {
    let t = r.trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|')) t = t.slice(0, -1);
    return t.split('|').map((c) => c.trim());
  };
  const flushTable = () => {
    if (!tableBuf) return;
    const head = parseRow(tableBuf[0]);
    const rows = tableBuf.slice(2);
    html +=
      '<div class="md-table-wrap"><table><thead><tr>' +
      head.map((c) => '<th>' + inline(c) + '</th>').join('') +
      '</tr></thead><tbody>' +
      rows.map((r) => '<tr>' + parseRow(r).map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') +
      '</tbody></table></div>';
    tableBuf = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (line.trim().startsWith('```')) {
      if (inCode) {
        html +=
          '<div class="code-wrap"><div class="code-head"><span class="code-lang">' +
          (codeLang ? escAttr(codeLang) : 'code') +
          '</span><button class="code-copy">复制</button></div><pre><code>' +
          highlightCode(codeBuf.join('\n')) + '</code></pre></div>';
        codeBuf = [];
        inCode = false;
        codeLang = '';
      } else {
        flushList();
        flushTable();
        inCode = true;
        codeLang = line.trim().slice(3).trim();
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    // 表格：当前行含 | 且下一行是分隔行时开始收集
    if (tableBuf) {
      if (line.trim() !== '' && line.includes('|')) {
        tableBuf.push(line);
        continue;
      }
      flushTable();
    } else if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushList();
      tableBuf = [line, lines[i + 1]];
      i++;
      continue;
    }
    // 分割线
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushList();
      flushTable();
      html += '<hr>';
      continue;
    }
    const mH = line.match(/^(#{1,4})\s+(.*)/);
    if (mH) {
      flushList();
      flushTable();
      const lv = mH[1].length;
      html += '<h' + lv + '>' + inline(mH[2]) + '</h' + lv + '>';
      continue;
    }
    const mUl = line.match(/^\s*[-*+]\s+(.*)/);
    if (mUl) {
      flushTable();
      if (listType !== 'ul') {
        flushList();
        html += '<ul>';
        listType = 'ul';
      }
      html += '<li>' + inline(mUl[1]) + '</li>';
      continue;
    }
    const mOl = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (mOl) {
      flushTable();
      if (listType !== 'ol') {
        flushList();
        html += '<ol>';
        listType = 'ol';
      }
      html += '<li>' + inline(mOl[1]) + '</li>';
      continue;
    }
    const mBq = line.match(/^\s*>\s?(.*)/);
    if (mBq) {
      flushList();
      flushTable();
      // 合并连续的引用行
      const buf = [mBq[1]];
      while (i + 1 < lines.length) {
        const m2 = lines[i + 1].replace(/\r$/, '').match(/^\s*>\s?(.*)/);
        if (!m2) break;
        buf.push(m2[1]);
        i++;
      }
      html += '<blockquote>' + buf.map(inline).join('<br>') + '</blockquote>';
      continue;
    }
    flushList();
    flushTable();
    if (line.trim() === '') {
      continue;
    }
    html += '<p>' + inline(line) + '</p>';
  }
  flushList();
  flushTable();
  if (streaming) {
    if (html.endsWith('</p>')) {
      html = html.slice(0, -4) + '<span class="stream-cursor"></span></p>';
    } else {
      html += '<p><span class="stream-cursor"></span></p>';
    }
  }
  return html || '<p>（无内容）</p>';
}

// ---- 面板：自由指令 + 流式输出 ----

// 引用标记匹配：支持 [n]、[ n ]、[标签n]、全角［n］。捕获括号内完整内容，数字取「结尾的数字」。
const CITE_RE = /[\uFF3B\u005B]([^\]]*?)[\uFF3D\u005D]/g;
// 提取括号内容结尾的引用编号；不是引用（无结尾数字）返回 null。
export function extractCiteNum(inner) {
  const m = String(inner || '').match(/(\d{1,2})\s*$/);
  return m ? parseInt(m[1], 10) : null;
}

// 最终回复后把引用重编号：按「正文中首次出现的顺序」重排为 1..N，且只保留正文实际引用到的来源。
// 这解决模型对来源编号不可靠的问题——正文永远从 [1] 开始，参考来源只列被引用的文章，二者一一对应。
export function renumberCitations(text, citations) {
  const list = Array.isArray(citations) ? citations : [];
  const src = String(text || '');
  // 每次操作都新建正则，杜绝共享 /g 正则的 lastIndex 状态残留
  // （exec 收集与 replace 替换分开用独立正则，绝不串状态）。
  const collectRe = /[\uFF3B\u005B]([^\]]*?)[\uFF3D\u005D]/g;
  // 收集正文里出现的所有不同引用编号（按首次出现顺序）。
  const order = [];
  const seen = new Set();
  let m;
  while ((m = collectRe.exec(src))) {
    const n = extractCiteNum(m[1]);
    if (n === null || seen.has(n)) continue;
    seen.add(n);
    order.push(n);
  }
  // 只保留能匹配到来源的编号：未知编号不重编号、也不生成来源（避免错配到别的来源或造假来源）。
  // 注意：返回全新对象副本，绝不改动传入的 citations（流式每 chunk 都会重编号，改动会破坏幂等）。
  const oldToNew = {};
  const cited = [];
  for (const old of order) {
    const found = list.find((c) => Number(c.index) === old);
    if (!found) continue;
    oldToNew[old] = cited.length + 1;
    cited.push(Object.assign({}, found, { index: cited.length + 1 }));
  }
  // 正文没有任何「可解析到来源」的引用时，参考来源区为空（不列出未被引用的来源）。
  if (!cited.length) return { text: src, citations: [] };
  const replaceRe = /[\uFF3B\u005B]([^\]]*?)[\uFF3D\u005D]/g;
  const newText = src.replace(replaceRe, (mm, inner) => {
    const old = extractCiteNum(inner);
    if (old === null) return mm;
    const label = inner.replace(/\s*\d+\s*$/, '');
    return oldToNew[old] !== undefined ? '[' + label + oldToNew[old] + ']' : mm;
  });
  return { text: newText, citations: cited };
}

// 跨页引用跳转：把证据片段以 base64url 放进 URL 查询参数，目标页内容脚本据此做容错高亮。
export function encodeSnippet(snippet) {
  try {
    return btoa(unescape(encodeURIComponent(String(snippet || ''))))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  } catch (e) {
    return '';
  }
}
export function decodeSnippet(b64) {
  try {
    let s = String(b64 || '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bytes = Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    return decodeURIComponent(new TextDecoder().decode(bytes));
  } catch (e) {
    return '';
  }
}
export function attachSnippetParam(url, snippet) {
  try {
    const clean = String(snippet || '').trim();
    const b64 = encodeSnippet(clean);
    if (!b64) return url;
    // 查询参数必须放在 # 之前（# 之后是片段，不会出现在 location.search）。
    const hashIdx = url.indexOf('#');
    const base = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
    const hash = hashIdx >= 0 ? url.slice(hashIdx) : '';
    const sep = base.indexOf('?') >= 0 ? '&' : '?';
    return base + sep + 'kbSnippet=' + b64 + hash;
  } catch (e) {
    return url;
  }
}

// 统一渲染入口：任何回答正文都先重编号引用再渲染，保证界面上永远显示从 [1] 连续的编号，
// 与参考来源区一致。所有 renderMarkdown 调用点都应改用本函数。
export function renderAnswer(text, citations, streaming) {
  const ren = renumberCitations(text, citations);
  return renderMarkdown(stripOptionsBlock(ren.text), ren.citations, streaming);
}

// 生成 Chrome 文本片段深链：在 URL 后追加 #:~:text=…，浏览器打开后会自动
// 滚动并高亮证据文本，让「跳转」真正落在引用出处，而不是落到页面顶部。
export function buildCitationDeepLink(url, snippet) {
  try {
    let clean = String(snippet || '')
      .replace(/^\[?\d*\]?\s*/, '') // 去掉开头的 [n] 编号
      .replace(/\s+/g, ' ')
      .replace(/…\s*$/g, '')
      .replace(/（页面内容过长，已截断）\s*$/g, '')
      .replace(/^网页正文（[^）]*）：\s*/, '')
      .replace(/^当前页面正文：\s*/, '')
      .trim();
    if (!clean.length) return url;
    // 从「首个句子边界之后」取一段更可能逐字命中的文本（Chrome 文本片段要求原文逐字匹配）。
    const sBreak = clean.search(/[。！？.!?]/);
    const sliceStart = sBreak >= 0 && sBreak <= 50 ? sBreak + 1 : 0;
    const start = clean.slice(sliceStart, sliceStart + 60).trim();
    const suffix = clean.slice(sliceStart + 60, sliceStart + 90).trim();
    if (start.length < 10) return url;
    const enc = (s) => encodeURIComponent(s).replace(/-/g, '%2D');
    let frag = ':~:text=' + enc(start);
    if (suffix.length) frag += '-' + enc(suffix);
    return url + (url.indexOf('#') >= 0 ? '' : '#') + frag;
  } catch (e) {
    return url;
  }
}

// 从展示文本中隐藏 <options> 程序块（含未闭合时），避免用户看到原始 JSON。
// 与 renderMarkdown 同属「纯字符串变换」，随渲染层一起放在本模块。
function stripOptionsBlock(text) {
  return String(text || '')
    .replace(/<options>[\s\S]*?(?:<\/options>|$)/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 渲染任务执行计划（update_plan 事件）；计划块置于当前 AI 回复顶部，随进度刷新。
