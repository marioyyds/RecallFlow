// Markdown / HTML 渲染层：这是把**模型输出与页面文本**拼成注入 DOM 的 HTML 的地方，
// 也是 XSS 风险面。此前埋在 chat.js（2900+ 行）里且零测试，无法在 node 中验证。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sanitizeHref,
  renderMarkdown,
  renderAnswer,
  escHtml,
  highlightCode,
  extractCiteNum,
  renumberCitations,
  encodeSnippet,
  decodeSnippet,
  attachSnippetParam,
  buildCitationDeepLink,
  planCitationOpen,
  parseSuggestionOptions,
} from '../lib/page/markdown.js';

// 引号感知地解析开始标签的属性名。
// 必须这样做：只看输出里有没有 "onmouseover" 字样会误报 —— 它可能只是被转义进
// href 值里的普通文本；而不识别引号又会把 href 里的 "?y=1&z=2" 误认成属性。
function attrsOfTag(html, tag) {
  const m = html.match(new RegExp('<' + tag + '\\b([^>]*)>'));
  if (!m) return null;
  const s = m[1];
  const names = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    const start = i;
    while (i < s.length && /[-a-zA-Z0-9_:.]/.test(s[i])) i++;
    const name = s.slice(start, i);
    if (!name) {
      i++;
      continue;
    }
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s[i] === '=') {
      i++;
      while (i < s.length && /\s/.test(s[i])) i++;
      const q = s[i];
      if (q === '"' || q === "'") {
        i++;
        while (i < s.length && s[i] !== q) i++;
        i++;
      } else {
        while (i < s.length && !/\s/.test(s[i])) i++;
      }
    }
    names.push(name.toLowerCase());
  }
  return names.sort();
}

const LINK_ATTRS = JSON.stringify(['href', 'rel', 'target']);

// ---------------------------------------------------------------- XSS / 属性注入

test('sanitizeHref: 拒绝可执行与本地协议', () => {
  for (const bad of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    '  javascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'blob:https://a/b',
  ]) {
    assert.equal(sanitizeHref(bad), '', '应拒绝：' + JSON.stringify(bad));
  }
});

test('sanitizeHref: 放行常规协议与相对路径', () => {
  for (const good of ['https://a.com/x?y=1&z=2', 'http://a.com', 'mailto:a@b.com', 'tel:+8613800000000', '/a/b', './c', '#frag', '?q=1']) {
    assert.equal(sanitizeHref(good), good, '应放行：' + good);
  }
  assert.equal(sanitizeHref(''), '');
  assert.equal(sanitizeHref(null), '');
  assert.equal(sanitizeHref('   '), '');
});

test('renderMarkdown: 链接不得被注入属性（回归：曾可直接注入 onmouseover）', () => {
  // 修复前输出为 <a href="x" onmouseover="alert(1" target="_blank">，事件处理器真实生效。
  // 判定方式必须是「解析开始标签的属性集」：
  //  - 只看有没有 "onmouseover" 字样会误报（它现在只是 href 值里的普通文本）
  //  - 先 replace('&quot;','') 再匹配也是错的 —— 那等于人为把转义还原，重建出注入形态。
  const out = renderMarkdown('[点我](x" onmouseover="alert(1))', null, false);
  assert.equal(JSON.stringify(attrsOfTag(out, 'a')), LINK_ATTRS, out);
  assert.ok(out.includes('&quot;'), '引号应被转义进 href 值：' + out);
});

test('renderMarkdown: 危险协议只保留文字，不生成链接', () => {
  for (const md of ['[点我](javascript:alert(1))', '[点我](JaVaScRiPt:alert(1))', '[点我](data:text/html,x)', '[点我](vbscript:x)']) {
    const out = renderMarkdown(md, null, false);
    assert.equal(attrsOfTag(out, 'a'), null, '不应生成 <a>：' + md + ' → ' + out);
    assert.ok(out.includes('点我'), '文字应保留：' + out);
  }
});

test('renderMarkdown: 正常链接不被二次转义（& 必须是单次转义）', () => {
  const out = renderMarkdown('[搜索](https://a.com/?q=1&b=2)', null, false);
  assert.ok(out.includes('href="https://a.com/?q=1&amp;b=2"'), out);
  assert.ok(!out.includes('&amp;amp;'), '不得二次转义：' + out);
  assert.equal(JSON.stringify(attrsOfTag(out, 'a')), LINK_ATTRS);
});

test('renderMarkdown: 外链带 rel=noopener（防反向标签劫持）', () => {
  const out = renderMarkdown('[x](https://a.com)', null, false);
  assert.ok(out.includes('rel="noopener noreferrer"'), out);
});

test('renderMarkdown: 模型输出里的原始 HTML 被转义，不会成为标签', () => {
  const out = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>', null, false);
  assert.ok(!out.includes('<script'), out);
  assert.ok(!/<img\b/i.test(out), out);
  assert.ok(out.includes('&lt;script&gt;'), out);
});

test('escHtml: 转义 & < >', () => {
  assert.equal(escHtml('<a href="x">&'), '&lt;a href="x"&gt;&amp;');
  assert.equal(escHtml(null), 'null');
});

test('highlightCode: 代码内容被转义后仍保留高亮标记', () => {
  const out = highlightCode('const a = "<b>"; // 注释');
  assert.ok(!out.includes('<b>'), '原始标签必须被转义：' + out);
  assert.ok(out.includes('&lt;b&gt;'), out);
  assert.ok(out.includes('tk-'), '应带高亮 class（实现用的是 tk-*）：' + out);
});

// ---------------------------------------------------------------- 引用编号

test('extractCiteNum: 取括号内容结尾的数字', () => {
  assert.equal(extractCiteNum('1'), 1);
  assert.equal(extractCiteNum(' 12 '), 12);
  assert.equal(extractCiteNum('K8s文档2'), 2);
  assert.equal(extractCiteNum('无数字'), null);
  assert.equal(extractCiteNum(''), null);
});

test('renumberCitations: 按正文首次出现顺序重排为 1..N', () => {
  const cites = [
    { index: 5, title: 'A', url: 'u5' },
    { index: 2, title: 'B', url: 'u2' },
  ];
  const r = renumberCitations('先看 [2] 再看 [5]', cites);
  assert.deepEqual(r.citations.map((c) => c.index), [1, 2]);
  assert.deepEqual(r.citations.map((c) => c.title), ['B', 'A'], '来源顺序应与正文出现顺序一致');
  assert.ok(r.text.includes('[1]') && r.text.includes('[2]'), r.text);
});

test('renumberCitations: 未知编号不重编号、不生成来源', () => {
  const r = renumberCitations('正文 [9]', [{ index: 5, title: 'A' }]);
  assert.deepEqual(r.citations, []);
  assert.equal(r.text, '正文 [9]', '无法解析到来源时应保持原样');
});

test('renumberCitations: 不改动传入的 citations（流式每 chunk 都调用，必须幂等）', () => {
  const cites = [{ index: 5, title: 'A' }];
  const snapshot = JSON.stringify(cites);
  renumberCitations('正文 [5]', cites);
  assert.equal(JSON.stringify(cites), snapshot, '入参必须保持不变');
});

test('renumberCitations: 全文无引用时来源区为空', () => {
  const r = renumberCitations('没有任何引用', [{ index: 1, title: 'A' }]);
  assert.deepEqual(r.citations, []);
  assert.equal(r.text, '没有任何引用');
  // 脏数据
  assert.deepEqual(renumberCitations(null, null).citations, []);
});

// ---------------------------------------------------------------- 渲染基础

test('renderMarkdown: 标题/列表/粗体/行内代码/引用块', () => {
  const out = renderMarkdown('# 标题\n\n- 甲\n- 乙\n\n**粗** 与 `代码`\n\n> 引文', null, false);
  assert.ok(out.includes('<h1>标题</h1>'), out);
  assert.ok(out.includes('<li>甲</li>'), out);
  assert.ok(out.includes('<strong>粗</strong>'), out);
  assert.ok(out.includes('<code>代码</code>'), out);
  assert.ok(out.includes('<blockquote>'), out);
});

test('renderMarkdown: 代码块保留内容并带语言 class', () => {
  const out = renderMarkdown('```js\nconst a = 1;\n```', null, false);
  assert.ok(out.includes('code-wrap'), out);
  assert.ok(out.includes('const'), out);
  assert.ok(out.includes('tk-'), '应带语法高亮 class：' + out);
  assert.ok(out.includes('js'), '应保留语言标记：' + out);
});

test('renderMarkdown: 表格渲染为 table', () => {
  const out = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |', null, false);
  assert.ok(out.includes('<table'), out);
  assert.ok(out.includes('<th'), out);
  assert.ok(out.includes('<td'), out);
});

test('renderMarkdown: 流式时追加光标；空内容有兜底', () => {
  assert.ok(renderMarkdown('正在输出', null, true).includes('stream-cursor'));
  assert.ok(!renderMarkdown('已结束', null, false).includes('stream-cursor'));
  assert.ok(renderMarkdown('', null, false).includes('无内容'));
});

test('renderMarkdown: 引用徽章 —— 有元数据时渲染为可点击按钮且属性被转义', () => {
  const cites = [{ index: 1, title: '标题"><img src=x>', id: 'i"1', url: 'https://a.com', snippet: 'snip"' }];
  const out = renderMarkdown('结论 [1]', cites, false);
  assert.ok(out.includes('cite-badge'), out);
  assert.ok(!out.includes('<img'), '标题里的标签必须被转义：' + out);
  assert.equal(JSON.stringify(attrsOfTag(out, 'button')), JSON.stringify(['class', 'data-cite-id', 'data-cite-snippet', 'data-cite-source', 'data-cite-url', 'title']));
});

test('renderMarkdown: 无引用元数据时 [n] 原样保留（不臆造徽章）', () => {
  const out = renderMarkdown('结论 [1]', null, false);
  assert.ok(!out.includes('cite-badge'), out);
  assert.ok(out.includes('[1]'), out);
});

// ---------------------------------------------------------------- 片段与深链

test('encodeSnippet/decodeSnippet: 往返一致（含中文与 URL 不安全字符）', () => {
  for (const s of ['普通文本', 'a+b/c=d', '带 "引号" & <标签>', 'emoji 🎯']) {
    assert.equal(decodeSnippet(encodeSnippet(s)), s, '往返失败：' + s);
  }
  // 输出必须是 URL 安全字符
  assert.match(encodeSnippet('a+b/c='), /^[A-Za-z0-9_-]+$/);
});

test('encodeSnippet/decodeSnippet: 脏数据返回空串而不抛错', () => {
  assert.equal(encodeSnippet(''), '');
  assert.equal(decodeSnippet(''), '');
  assert.equal(decodeSnippet('!!!非base64!!!'), '');
});

test('attachSnippetParam: 参数放在 # 之前，且区分已有查询串', () => {
  assert.equal(attachSnippetParam('https://a.com/', 'x'), 'https://a.com/?kbSnippet=' + encodeSnippet('x'));
  assert.ok(attachSnippetParam('https://a.com/?p=1', 'x').includes('?p=1&kbSnippet='));
  const withHash = attachSnippetParam('https://a.com/#sec', 'x');
  assert.ok(withHash.indexOf('kbSnippet=') < withHash.indexOf('#sec'), withHash);
  assert.equal(attachSnippetParam('https://a.com/', ''), 'https://a.com/', '空片段不改动 URL');
});

test('buildCitationDeepLink: 生成 Chrome 文本片段深链', () => {
  // 实现要求首段 ≥10 字（Chrome 文本片段需足够长才能唯一匹配），因此用长片段。
  const snippet = '这是用于定位证据的一段足够长的正文文本内容';
  const link = buildCitationDeepLink('https://a.com/p', snippet);
  assert.ok(link.includes('#:~:text='), link);
  assert.ok(link.startsWith('https://a.com/p'), link);
  assert.ok(link.length > 'https://a.com/p#:~:text='.length, '应带上编码后的文本：' + link);
});

test('buildCitationDeepLink: 片段过短时原样返回（有意为之，Chrome 需要足够长的匹配文本）', () => {
  assert.equal(buildCitationDeepLink('https://a.com/p', '太短'), 'https://a.com/p');
  assert.equal(buildCitationDeepLink('https://a.com/p', ''), 'https://a.com/p');
});

test('buildCitationDeepLink: 剥掉引用编号与截断标记后再取文本', () => {
  const link = buildCitationDeepLink('https://a.com/p', '[3] 去掉编号之后的正文内容也要足够长才行');
  assert.ok(!link.includes('%5B3%5D'), '不应把 [n] 编号带进片段：' + link);
});

// ---------------------------------------------------------------- 建议按钮解析
// parseSuggestionOptions 解析的是**模型输出**，决定了面板底部出现哪些按钮。

test('parseSuggestionOptions: 优先解析 <options> JSON 块', () => {
  const out = parseSuggestionOptions('做完了 <options>[{"label":"继续","desc":"接着做"},{"label":"停止"}]</options>');
  assert.deepEqual(out, [
    { label: '继续', desc: '接着做' },
    { label: '停止', desc: '' },
  ]);
});

test('parseSuggestionOptions: JSON 块非法时回退到【可选操作】列表', () => {
  const out = parseSuggestionOptions('正文\n\n【可选操作】\n- 【看结果】打开页面看看\n2. 【再改一版】调整样式');
  assert.deepEqual(out, [
    { label: '看结果', desc: '打开页面看看' },
    { label: '再改一版', desc: '调整样式' },
  ]);
});

test('parseSuggestionOptions: JSON 合法但条目全缺 label 时也回退', () => {
  const out = parseSuggestionOptions('<options>[{"desc":"没有标签"}]</options>\n【可选操作】\n- 【兜底项】说明');
  assert.deepEqual(out, [{ label: '兜底项', desc: '说明' }]);
});

test('parseSuggestionOptions: 最多 4 条（按钮过多会挤占输入区）', () => {
  const many = '<options>' + JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ label: 'L' + i }))) + '</options>';
  assert.equal(parseSuggestionOptions(many).length, 4);
  const manyList = '【可选操作】\n' + Array.from({ length: 9 }, (_, i) => '- 【L' + i + '】d').join('\n');
  assert.equal(parseSuggestionOptions(manyList).length, 4);
});

test('parseSuggestionOptions: 非法输入返回空数组而不抛错（前端退化为纯文本）', () => {
  for (const bad of ['', null, undefined, '普通回答没有建议', '<options>不是 JSON</options>', '<options>{"a":1}</options>']) {
    assert.deepEqual(parseSuggestionOptions(bad), [], '输入 ' + JSON.stringify(bad));
  }
});

test('parseSuggestionOptions: 标签长度边界为 12 字（防止把正文中括号误判成按钮）', () => {
  // 用 repeat 构造，避免手数字数出错（这里正则按 UTF-16 码元计数，'标' 占 1）
  const label12 = '标'.repeat(12);
  const label13 = '标'.repeat(13);
  assert.equal(label12.length, 12);
  assert.equal(label13.length, 13);
  assert.deepEqual(
    parseSuggestionOptions('【可选操作】\n- 【' + label12 + '】说明'),
    [{ label: label12, desc: '说明' }],
    '12 字应被接受'
  );
  assert.deepEqual(parseSuggestionOptions('【可选操作】\n- 【' + label13 + '】说明'), [], '13 字应被拒绝');
});

// ---------------------------------------------------------------- 统一入口

test('renderAnswer: 先重编号再渲染，并隐藏 <options> 程序块', () => {
  const out = renderAnswer('已处理 [5]\n<options>{"a":1}</options>', [{ index: 5, title: 'A' }], false);
  assert.ok(out.includes('[1]'), '应重编号为 1：' + out);
  assert.ok(!out.includes('options'), '不应暴露程序块：' + out);
  assert.ok(!out.includes('{"a":1}'), out);
});

test('renderAnswer: 脏数据安全', () => {
  assert.equal(typeof renderAnswer('', null, false), 'string');
  assert.equal(typeof renderAnswer(null, undefined, true), 'string');
});

// ---------------------------------------------------------------- 引用点击策略
// 点击引用时会 window.open(url)，而 url 来自 data-cite-url（页面/模型可控）。
// 把「能不能打开」抽成纯函数，正是为了让这条安全策略可测。

test('planCitationOpen: 同源同路径 → 就地高亮，不跳转', () => {
  const p = planCitationOpen('https://a.com/p?x=1', 'https://a.com/p', '证据');
  assert.equal(p.action, 'highlight');
  assert.equal(p.target, undefined);
});

test('planCitationOpen: 相对路径按当前页解析，同路径也算同页', () => {
  assert.equal(planCitationOpen('/p', 'https://a.com/p', 'x').action, 'highlight');
  assert.equal(planCitationOpen('/other', 'https://a.com/p', 'x').action, 'open');
});

test('planCitationOpen: 危险协议一律拒绝打开（javascript: 能骗过同页判定）', () => {
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<h1>钓鱼</h1>', 'vbscript:x', 'file:///etc/passwd']) {
    const p = planCitationOpen(bad, 'https://a.com/p', '证据文本要够长才能生成深链');
    assert.equal(p.action, 'deny', '应拒绝：' + bad);
    assert.ok(p.reason && p.reason.includes('协议'), p.reason);
  }
});

test('planCitationOpen: 跨页 http(s) → 生成带深链与片段参数的目标', () => {
  const snippet = '这是一段足够长的证据文本用于生成文本片段深链';
  const p = planCitationOpen('https://b.com/x', 'https://a.com/p', snippet);
  assert.equal(p.action, 'open');
  assert.ok(p.target.startsWith('https://b.com/x'), p.target);
  assert.ok(p.target.includes('#:~:text='), p.target);
  assert.ok(p.target.includes('kbSnippet='), p.target);
});

test('planCitationOpen: 无 url → none（调用方再回退到按 id 打开知识库）', () => {
  assert.equal(planCitationOpen('', 'https://a.com/p', 'x').action, 'none');
  assert.equal(planCitationOpen(null, 'https://a.com/p', 'x').action, 'none');
  assert.equal(planCitationOpen('   ', 'https://a.com/p', 'x').action, 'none');
});

test('planCitationOpen: 当前页地址非法时不抛错', () => {
  assert.equal(typeof planCitationOpen('https://a.com', 'not-a-url', '').action, 'string');
});
