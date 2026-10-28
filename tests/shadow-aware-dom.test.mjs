// 「穿透 shadow DOM 的命中判定」门禁。
//
// ## 起因（做 Shadow DOM 场景时挖出的真缺陷，而且是**静默**的）
//
// `isElementCovered` 原用 `document.elementFromPoint(x, y)` 判断元素是否被遮挡，
// 但**它只到 shadow 宿主为止**（不进入 shadow tree）。于是任何 shadow 内的元素
// 都会被判成"被宿主遮挡"。实测后果：
//   · `type_text` 往组件内的输入框打字**直接失败**，报
//     「目标输入元素不可操作（不可见、被遮挡或尚未就绪）」——
//     而这句话又把人引向"元素状态不对"，完全指不到"判定本身不穿透 shadow"；
//   · `click_element` 看似能用，其实只是靠"被遮挡就改用程序化点击"的兜底，
//     而且反馈里那句「被遮挡」是**假的**。
//
// 修法：命中点从 shadow 宿主逐层下钻（`ShadowRoot.elementFromPoint`），
// 再用**跨 shadow 边界上升**的方式判断"命中元素是不是它自己或它的后代"
// （`Node.contains` 不跨 shadow 边界，不能用来做这件事）。
//
// 这条门禁盯住"别再退回不穿透的写法"。行为层的证明在
// tests/e2e/golden.spec.mjs 的「Shadow DOM」用例（它会在 shadow 里真的打字）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const cmdSrc = fs.readFileSync('lib/application/page/commands/actions.ts', 'utf8');

/** 取一个顶层函数的源码体（到下一个顶层 function 为止）。 */
function fnBody(src, name) {
  const re = new RegExp('^(?:async\\s+)?function\\s+' + name + '\\s*\\(', 'm');
  const m = re.exec(src);
  if (!m) return '';
  const rest = src.slice(m.index + m[0].length);
  const next = /^(?:async\s+)?function\s+\w+\s*\(/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

test('document.elementFromPoint 只允许出现在 deepestElementAt 里（它是唯一被认可的封装）', () => {
  // 直接把 `document.elementFromPoint` 用在别处 = 又写出一个 shadow 盲的判定。
  const occurrences = [...cmdSrc.matchAll(/document\.elementFromPoint\(/g)].length;
  const wrapper = fnBody(cmdSrc, 'deepestElementAt');
  const inWrapper = [...wrapper.matchAll(/document\.elementFromPoint\(/g)].length;
  assert.ok(occurrences > 0, '应至少有一处（deepestElementAt 内部）');
  assert.equal(
    occurrences,
    inWrapper,
    'commands.js 里出现了 deepestElementAt 之外的 document.elementFromPoint（那是 shadow 盲的判定）'
  );
});

test('deepestElementAt 逐层下钻 shadow：用 ShadowRoot.elementFromPoint 并设了层数上限', () => {
  const body = fnBody(cmdSrc, 'deepestElementAt');
  assert.ok(body, '应能找到 deepestElementAt');
  assert.match(body, /shadowRoot\.elementFromPoint\(/, '必须用 ShadowRoot 上的 elementFromPoint 下钻');
  assert.match(body, /guard\s*<\s*\d+/, '下钻必须带上限（异常结构不能变成死循环）');
});

test('isElementCovered 必须用 deepestElementAt，且不能再用裸的 elementFromPoint', () => {
  const body = fnBody(cmdSrc, 'isElementCovered');
  assert.ok(body, '应能找到 isElementCovered');
  assert.match(body, /deepestElementAt\(/, '必须经 deepestElementAt 取命中元素');
  assert.ok(!/document\.elementFromPoint/.test(body), '不得在 isElementCovered 里直接调 elementFromPoint');
});

test('判断"命中元素是不是它自己/后代"必须跨 shadow 边界上升（contains 不跨边界）', () => {
  const body = fnBody(cmdSrc, 'isSelfOrShadowDescendant');
  assert.ok(body, '应能找到 isSelfOrShadowDescendant');
  assert.match(body, /nodeType\s*===\s*11/, 'ShadowRoot 的 nodeType 是 11，要经 host 接回宿主的树');
  assert.match(body, /\.host\b/, '必须经 .host 上升');
  // 用 contains 做这件事是错的：它不跨 shadow 边界
  assert.ok(!/\.contains\(/.test(body), '不能用 contains 判断 shadow 后代');

  const covered = fnBody(cmdSrc, 'isElementCovered');
  assert.match(covered, /isSelfOrShadowDescendant\(/, 'isElementCovered 必须用它');
  assert.ok(!/el\.contains\(/.test(covered), '不得退回 contains 判断');
});

test('这条门禁本身有牙齿：裸用 elementFromPoint / contains 必须被判为不合格', () => {
  const badCovered = 'const top = document.elementFromPoint(x, y); return top !== el && !el.contains(top);';
  assert.match(badCovered, /document\.elementFromPoint/, '旧写法应被检出');
  assert.match(badCovered, /el\.contains\(/, '旧写法里的 contains 应被检出');

  const goodCovered = 'const top = deepestElementAt(x, y); return !isSelfOrShadowDescendant(top, el);';
  assert.ok(!/document\.elementFromPoint/.test(goodCovered), '新写法不含裸查询');
  assert.ok(!/el\.contains\(/.test(goodCovered), '新写法不含 contains');
  assert.match(goodCovered, /deepestElementAt/, '新写法含下钻');
});
