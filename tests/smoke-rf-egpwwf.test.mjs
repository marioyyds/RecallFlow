// 会话 RF-EGPWWF 里三处已确认缺陷的回归测试。
//
// ① `stripHtml` 只吃掉块级标签的**开头**，属性全留成「正文」——
//    实测抓 GitHub 得到 `style="min-height:101vh"> data-component="Stack"class="…"`
//    这样的属性汤，却因为字符数够多被当成抓取**成功**上报（静默失败）。
// ② `PAGE_TEXT_EXCLUDE` 里的 `#__kb-ai-host` 对本扩展自己的面板**完全失效**：
//    `closest()` 走到 ShadowRoot 就停，永远到不了宿主。实测 `hover_element` 的
//    「关键元素」里混进了 `rf-69：✓ 工具已完成：get_entry` 这类**自己的工具日志**。
// ③ `list_macros` 用同一个 `：` 拼名字与描述 → `run_macro` 名字有歧义，实测连错两次；
//    而报错只说「可用 list_macros 查看」，等于把活推回给调用方。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { stripHtml } from '../lib/assistant/tools.js';
import { closestComposed, isPageContentExcluded, PAGE_TEXT_EXCLUDE } from '../lib/page/citation.js';

// ---------------------------------------------------------------- ① stripHtml

test('stripHtml：带属性的块级标签不得把属性留成正文', () => {
  const html = '<div style="min-height:101vh" data-component="Stack" class="prc-Stack-UQ9k6"><p class="x">真正的正文</p></div>';
  const text = stripHtml(html);
  assert.ok(text.includes('真正的正文'), text);
  for (const leak of ['style=', 'data-component=', 'class=', 'min-height', 'prc-Stack']) {
    assert.ok(!text.includes(leak), '属性泄漏进了正文：' + leak + '\n实际：' + text);
  }
});

test('stripHtml：这正是那次抓 GitHub 的形态（对照实测输出）', () => {
  // 实测返回的开头就是 `style="min-height:101vh"> data-component="Stack"class="…"`
  const html = '<div style="min-height:101vh"><div data-component="Stack" class="prc-Stack-Stack-UQ9k6" data-direction="horizontal"><main>Hello</main></div></div>';
  const text = stripHtml(html).replace(/\s+/g, ' ').trim();
  assert.equal(text, 'Hello', '应只剩正文，实际：' + text);
});

test('stripHtml：段落结构仍以换行保留（修完不能把结构也吃掉）', () => {
  const text = stripHtml('<p>第一段</p><p>第二段</p>');
  assert.ok(/第一段[\s\S]*第二段/.test(text), text);
  assert.ok(/\n/.test(text), '块级标签之间应有换行：' + JSON.stringify(text));
});

test('stripHtml：自闭合与带斜杠的写法同样处理干净', () => {
  const text = stripHtml('<div class="a"/><br/><li data-x="1">项</li>');
  assert.ok(!/class=|data-x=|\//.test(text), '残余标签痕迹：' + JSON.stringify(text));
  assert.ok(text.includes('项'), text);
});

// ---------------------------------------------------------------- ② 穿透 shadow 的排除

/** 造一个 element 替身。 */
function el(tag, attrs = {}, parent = null) {
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    parentNode: parent,
    matches(sel) {
      return String(sel)
        .split(',')
        .some((s) => {
          const t = s.trim();
          if (t.startsWith('#')) return attrs.id === t.slice(1);
          if (t.startsWith('.')) return String(attrs.class || '').split(/\s+/).includes(t.slice(1));
          return t.toUpperCase() === this.tagName;
        });
    },
  };
  return node;
}
/** 造一个 ShadowRoot 替身（nodeType 11 + host）。 */
function shadowRoot(host) {
  return { nodeType: 11, host, parentNode: null };
}

test('closestComposed：能穿过 shadow 边界找到宿主', () => {
  const host = el('div', { id: '__kb-ai-host' });
  const root = shadowRoot(host);
  const inner = el('div', { class: 'agent-step' }, root);
  assert.equal(typeof inner.closest, 'undefined', '前提：这个替身不实现原生 closest');
  assert.equal(closestComposed(inner, '#__kb-ai-host'), host, '必须穿过 ShadowRoot 找到宿主');
});

test('isPageContentExcluded：面板（shadow 内）的元素必须被判为「非页面内容」', () => {
  const host = el('div', { id: '__kb-ai-host' });
  const inner = el('summary', {}, shadowRoot(host));
  assert.equal(isPageContentExcluded(inner), true, '这就是那次的 rf-69「✓ 工具已完成」所在位置');
  assert.equal(isPageContentExcluded(host), true);
});

test('isPageContentExcluded：普通页面元素不受影响（不能过度排除）', () => {
  const body = el('body');
  const p = el('p', {}, body);
  const nested = el('span', {}, p);
  assert.equal(isPageContentExcluded(nested), false);
  assert.equal(isPageContentExcluded(null), false);
});

test('isPageContentExcluded：深层 shadow（shadow 里再套 shadow）也要穿透', () => {
  const outerHost = el('div', { id: '__kb-ai-host' });
  const innerHost = el('div', {}, shadowRoot(outerHost));
  const deep = el('span', {}, shadowRoot(innerHost));
  assert.equal(isPageContentExcluded(deep), true, '嵌套 shadow 同样要能上溯到宿主');
});

test('接线：page-text.js 不得再用原生 closest 做排除', () => {
  const src = fs.readFileSync('lib/page/page-text.js', 'utf8');
  assert.ok(!/el\.closest\(PAGE_TEXT_EXCLUDE\)/.test(src), '原生 closest 到 ShadowRoot 就停，会漏掉自己的面板');
  assert.ok(/isPageContentExcluded\(el\)/.test(src), '应改用穿透 shadow 的判断');
});

// ---------------------------------------------------------------- ③ 宏名不再有歧义

test('接线：list_macros 必须显式标出 name（原写法名字与描述共用 `：`，边界歧义）', () => {
  const src = fs.readFileSync('lib/assistant/tools.js', 'utf8');
  assert.ok(/name="' \+ m\.name \+ '"/.test(src), 'list_macros 应把 name 用引号显式标出');
  assert.ok(
    !/\+ m\.name \+ \(m\.description \? '：'/.test(src),
    '旧的「名字：描述」拼法应已消失 —— 实测它让 agent 连试两次才猜对名字'
  );
});

test('接线：run_macro 找不到时必须列出可用宏名，而不是让调用方自己去看', () => {
  const src = fs.readFileSync('lib/assistant/tools.js', 'utf8');
  assert.ok(/本站可用的宏名如下，请照抄 name 的值/.test(src), '报错要直接给出候选');
  assert.ok(
    !/未找到宏「' \+ name \+ '」（可用 list_macros 查看）/.test(src),
    '旧的「可用 list_macros 查看」应已消失'
  );
});
