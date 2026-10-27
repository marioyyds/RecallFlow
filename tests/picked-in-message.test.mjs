// 拾取元素要「跟着消息留在对话里」：显示 + 持久化。
//
// 起因：用户反馈「选中页面元素时，对话中不显示所选元素的信息」。
// 查下来不是渲染坏了，而是**这条信息从来没有进过对话**：
//   · 待发送条 pickBar 有它（发之前看得见）；
//   · 发给模型的元数据很完整（buildInitialMessages 里 role/name/选择器/祖先链/源码位置都有）；
//   · 但用户气泡只渲染了 instruction，conversation 里也只存了 content；
//   · 发送后 pickedElements 直接清空 → 痕迹彻底消失，刷新更找不回。
// 而交接包**反而带着**它（handoff.js），于是出现"外部 AI 看得到、用户自己看不到"的倒挂。
//
// 这里钉住三件事：① 纯函数的行为与**转义**；② 两条渲染路径共用同一个格式化函数；
// ③ 持久化白名单里有它（少这一条就会"当时看得见、刷新后没了"）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  summarizePickedForMessage,
  formatPickedSummary,
  pickedSummaryHtml,
} from '../lib/shared/utils.js';

const chatSrc = fs.readFileSync('lib/page/chat.ts', 'utf8');
const transcriptSrc = fs.readFileSync('lib/page/transcript.ts', 'utf8');
const agentSrc = fs.readFileSync('lib/assistant/agent.js', 'utf8');

/**
 * 取一个顶层函数的**函数体**（按花括号配对），用于源码级门禁。
 *
 * 为什么要它：原先这两条断言用「从函数签名起切 1600 字符」的定长窗口。定长窗口是
 * **脆**的——只要函数签名上方的参数/返回类型标注变长，被盯的字面量就被挤出窗口，
 * 门禁变红而语义完好（L-37 家族）。实测：`transcript.ts` 迁移时补的类型标注让
 * `copy.pickedElements = ...` 的偏移涨到 1527，离 1600 只剩 73 字符余量；而同一份文件
 * 在 CRLF 检出下每行多 1 字节，偏移直接变成 1556 —— 换个 `core.autocrlf` 就红（L-19）。
 *
 * 两个修法都在这里做掉：①锚到函数体自然边界，不再靠数字；②先把 CRLF 归一成 LF，
 * 让门禁与行尾无关。函数体若真的找不到闭合括号，退回「到文件末」——
 * 那时断言只会更严（照旧校验整段），不会静默放行。
 */
function functionBody(src, signature) {
  const s = String(src).replace(/\r\n/g, '\n');
  const at = s.indexOf(signature);
  assert.ok(at > 0, '应能找到 ' + signature);
  const open = s.indexOf('{', at);
  if (open < 0) return s.slice(at);
  let depth = 0;
  for (let k = open; k < s.length; k += 1) {
    if (s[k] === '{') depth += 1;
    else if (s[k] === '}') {
      depth -= 1;
      if (depth === 0) return s.slice(at, k + 1);
    }
  }
  return s.slice(at);
}

const onePick = {
  tag: 'button',
  label: '提交',
  selector: '#submit',
  locator: { role: 'button', name: '提交' },
  source: { file: 'src/App.vue', line: 42, column: 3 },
};

// ---------------------------------------------------------------- 压缩（要存进会话的那份）

test('summarizePickedForMessage：只留下渲染一行所需的字段', () => {
  const out = summarizePickedForMessage([onePick]);
  assert.equal(out.length, 1);
  assert.deepEqual(Object.keys(out[0]).sort(), ['label', 'loc', 'locator', 'tag']);
  assert.equal(out[0].tag, 'button');
  assert.equal(out[0].label, '提交');
  assert.equal(out[0].loc, 'src/App.vue:42');
  assert.equal(out[0].locator, 'role=button name="提交"');
  // 不该把给模型用的那堆（text/ancestors/rect）一起存进来 —— 那是另一条路径的事
  assert.ok(!('text' in out[0]) && !('ancestors' in out[0]));
});

test('summarizePickedForMessage：非数组 / 垃圾输入不抛，返回空数组', () => {
  for (const bad of [undefined, null, 'x', 42, {}]) {
    assert.deepEqual(summarizePickedForMessage(bad), []);
  }
  // 数组里的垃圾项被过滤掉
  assert.deepEqual(summarizePickedForMessage([null, 'x', 1, onePick]).length, 1);
});

test('summarizePickedForMessage：上限 8 条（会话存储有限，多选再多也只展示前几条）', () => {
  const many = Array.from({ length: 20 }, (_, i) => Object.assign({}, onePick, { label: 'b' + i }));
  assert.equal(summarizePickedForMessage(many).length, 8);
});

test('summarizePickedForMessage：定位符按 role/name → testid → 选择器 → 标签 回退', () => {
  const cases = [
    [{ locator: { role: 'link' } }, 'role=link'],
    [{ locator: { name: '帮助' } }, 'name="帮助"'],
    [{ locator: { testid: 'submit-btn' } }, 'testid=submit-btn'],
    [{ selector: '#a' }, '#a'],
    [{ tag: 'div' }, 'div'],
    [{}, ''],
  ];
  for (const [input, expected] of cases) {
    assert.equal(summarizePickedForMessage([input])[0].locator, expected, JSON.stringify(input));
  }
});

test('summarizePickedForMessage：字段截断，防止一条畸形拾取把会话撑大', () => {
  const out = summarizePickedForMessage([
    { tag: 't'.repeat(200), label: 'l'.repeat(200), selector: 's'.repeat(500), source: { file: 'f'.repeat(500), line: 1 } },
  ])[0];
  assert.equal(out.tag.length, 40);
  assert.equal(out.label.length, 60);
  assert.equal(out.locator.length, 200);
  assert.ok(out.loc.length <= 210, 'loc 也应被截断：' + out.loc.length);
});

test('summarizePickedForMessage：没有源码位置时 loc 为空串（不写 undefined）', () => {
  assert.equal(summarizePickedForMessage([{ tag: 'div' }])[0].loc, '');
});

// ---------------------------------------------------------------- 文本摘要

test('formatPickedSummary：单条不加序号，多条加序号并用分号连接', () => {
  assert.equal(formatPickedSummary([{ tag: 'button', label: '提交', loc: 'a.vue:1' }]), 'button「提交」 → a.vue:1');
  const two = formatPickedSummary([
    { tag: 'button', label: 'A' },
    { tag: 'input', label: 'B' },
  ]);
  assert.match(two, /^1\. button「A」；2\. input「B」$/);
});

test('formatPickedSummary：缺 label / 缺 tag 都有兜底，且空输入返回空串', () => {
  assert.equal(formatPickedSummary([{ tag: 'div' }]), 'div');
  assert.equal(formatPickedSummary([{ label: 'X' }]), '元素「X」');
  assert.equal(formatPickedSummary([]), '');
  assert.equal(formatPickedSummary(null), '');
});

// ---------------------------------------------------------------- HTML（转义是安全边界）

test('**安全**：页面来的标签与 label 必须转义（否则能在面板里执行脚本）', () => {
  const evil = {
    tag: 'img',
    label: '<img src=x onerror="window.__pwned=1">',
    locator: { name: '"><script>alert(1)</script>' },
    source: { file: 'a.vue', line: 1 },
  };
  const html = pickedSummaryHtml([evil]);
  assert.ok(!/<img/.test(html), '不得出现未转义的标签：' + html);
  assert.ok(!/<script/i.test(html), '不得出现未转义的 script：' + html);
  assert.ok(html.includes('&lt;img'), '应转义成实体');
  // title 属性里的引号也必须转义，否则能闭合属性注入
  assert.ok(!/title="[^"]*"[^>]*onerror/.test(html), 'title 属性被逃逸：' + html);
  assert.ok(html.includes('&quot;'), '属性里的引号应转义');
});

test('pickedSummaryHtml：无拾取时返回空串（调用方据此决定要不要插入）', () => {
  assert.equal(pickedSummaryHtml([]), '');
  assert.equal(pickedSummaryHtml(null), '');
  assert.equal(pickedSummaryHtml(undefined), '');
});

test('pickedSummaryHtml：带 class 与 title（title 里是定位符，便于悬停查看完整信息）', () => {
  const html = pickedSummaryHtml([{ tag: 'button', label: '提交', locator: 'role=button name="提交"' }]);
  assert.match(html, /class="user-picks"/);
  assert.match(html, /title="role=button name=&quot;提交&quot;"/);
  assert.ok(html.includes('⟡'), '应有一个可识别的前缀符号');
});

test('pickedSummaryHtml：没有定位符时不生成空 title 属性', () => {
  const html = pickedSummaryHtml([{ tag: 'div' }]);
  assert.ok(!html.includes('title='), '不该输出空 title：' + html);
});

// ---------------------------------------------------------------- 接线

test('两条渲染路径共用同一个格式化函数（各写一份会漂移）', () => {
  const calls = chatSrc.match(/pickedSummaryHtml\(/g) || [];
  // 只有两处调用点（实时发送 / 历史重放）；import 语句里没有左括号，不参与计数
  assert.equal(calls.length, 2, 'pickedSummaryHtml 应恰好被调用 2 次，实际 ' + calls.length);
  // 实时发送那条
  assert.match(
    chatSrc,
    /'<div class="msg user">' \+ escHtml\(instruction\) \+ selectedTextMessageHtml\(selectedForMessage\) \+ pickedSummaryHtml\(pickedForMessage\)/
  );
  // 历史重放那条（注意整行是 `'<div class="user-turn"><div class="msg user">' + …` 一个字符串字面量）
  assert.match(
    chatSrc,
    /<div class="msg user">' \+ escHtml\(m\.content\) \+ selectedTextMessageHtml\(m\.selectedText\) \+ pickedSummaryHtml\(m\.pickedElements\)/
  );
  // 不允许在别处再手写一份同样的行（比如直接拼 '⟡ '）
  assert.ok(!/escHtml\([^)]*\) \+ '⟡ /.test(chatSrc), '不应有手写的第二份渲染');
});

test('定位串只有一处实现：三处调用点都走 formatElementLocator', () => {
  // 这个字符串原本有三份手写实现，其中一份在"只有 name 没有 role"时会输出畸形的
  // `role=name="…"` —— 而"复制定位"按钮复制的正是它。改成唯一来源后不会再漂移。
  const utilsSrc = fs.readFileSync('lib/shared/utils.js', 'utf8');
  assert.match(utilsSrc, /export function formatElementLocator\(/);
  // 三处调用：给模型的元数据（agent.js）、chip 文案与"复制定位"（chat.js）、
  // 存进会话的那一行（utils.js 内的 summarizePickedForMessage）
  assert.match(agentSrc, /formatElementLocator\(l\)/, 'agent.js 应走共用实现');
  assert.match(chatSrc, /formatElementLocator\(p && p\.locator/, 'chat.js 应走共用实现');
  // 锚点钉"这一处仍调用共用实现"，不钉它外面套了什么：
  // 2026-10-16 外面包了一层 sliceSafe（截断不许切裂代理对），钉死外层写法会把门禁钉红。
  assert.match(utilsSrc, /formatElementLocator\(p\.locator, p\.selector, p\.tag\)/, 'summarizePickedForMessage 应走共用实现');
  // 不该再有第二份手写：旧的畸形写法（把 role 拼成空串再补 name）必须消失。
  // ⚠ 必须先剥掉**注释**：那段畸形的写法本身就是作为"反面例子"写在 utils.js 的注释里的，
  // 不剥注释会把自己举的例子当成违规（实测踩过一次）。
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  assert.ok(
    !/'role=' \+ \(l\.role \|\| ''\)/.test(stripComments(chatSrc) + stripComments(utilsSrc)),
    '畸形的 role 拼接写法应已全部移除（注释里的反面例子不算）'
  );
});

test('发送时把拾取信息写进那条 user 消息（否则对话里没有它）', () => {
  assert.match(chatSrc, /const pickedForMessage = summarizePickedForMessage\(pickedElements\);/);
  assert.match(chatSrc, /pickedForMessage\.length \? \{ pickedElements: pickedForMessage \} : \{\}/);
  // 取值必须在清空之前：清空点只有一个，且在 sendAgentRequest 里
  const takeAt = chatSrc.indexOf('const pickedForMessage = summarizePickedForMessage');
  const clearAt = chatSrc.indexOf('pickedElements = [];', takeAt);
  assert.ok(takeAt > 0 && clearAt > takeAt, '应先取值再清空');
});

test('**持久化白名单**里必须有 pickedElements（漏了就"当时看得见、刷新后没了"）', () => {
  // 白名单式字段拷贝：新字段不加进去就存不下来 —— 而症状看起来像渲染问题，极易误判。
  // ⚠ 白名单的实现在本轮从 chat.js **搬到了 transcript.js**（纯函数、可单测）。
  // 门禁因此跟着搬：它盯的是**语义**（这个字段必须被拷贝），不是某个文件的位置。
  const body = functionBody(transcriptSrc, 'export function serializeConversationMessages(');
  assert.match(body, /copy\.pickedElements = m\.pickedElements\.slice\(0, 8\)/, '白名单里必须拷贝 pickedElements');
});

test('模型上下文**不受影响**：给模型的那份仍由 agent.js 单独装配', () => {
  // 本轮刻意不动模型上下文（用户选的是"显示 + 持久化"）。
  // 这条断言防的是"顺手把两份合并"——那会改变每轮的 token 量。
  assert.match(agentSrc, /const pickedBlocks = picks\.map/, 'agent.js 仍应有自己那份元数据装配');
  assert.match(agentSrc, /buildInitialMessagesPure\(\{/, '仍应交给纯函数装配');
  // 会话里存的那份是**压缩后**的，不含 text/ancestors —— 两者形状不同正是刻意的
  const body = functionBody(transcriptSrc, 'export function serializeConversationMessages(');
  assert.ok(!/ancestors/.test(body), '会话里不该存祖先链（那是给模型看的）');
});
