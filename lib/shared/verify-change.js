// verify_change 断言求值：把「目标声明 + 页面观测到的渲染态」判成通过/未通过。
//
// 设计要点：
// 1. **纯函数**：不接触浏览器与文件，便于单测（断言语义最容易写错，必须可测）。
// 2. **默认断言是「元素存在」**：调用了 verify_change 却没说期望什么，最低要求就是它还在。
// 3. **未通过必须给出路**：遵循 docs/tool-design.md —— 错误信息要让 agent 不靠猜就能决定下一步。
// 4. `count` 独立于 found：断言 `count: 0`（元素应消失）必须能通过，
//    不能因为「找不到元素」就判失败 —— 那是最常见的误判。

/** 归一化文本：折叠空白并去首尾。断言与观测两侧都用它，避免空格/换行差异造成假失败。 */
export function normalizeText(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/\s+/g, ' ')
    .trim();
}

function describeLocator(target) {
  const t = target || {};
  if (t.selector) return '选择器 ' + t.selector;
  if (t.ref) return 'ref ' + t.ref;
  if (t.role || t.name) return 'role=' + (t.role || '') + ' name=' + (t.name || '');
  if (t.testid) return 'testid ' + t.testid;
  if (t.text) return '文本「' + String(t.text).slice(0, 40) + '」';
  return '未提供定位方式';
}

function formatCountExpect(e) {
  if (e && typeof e === 'object') {
    const parts = [];
    if (e.min !== undefined) parts.push('≥' + e.min);
    if (e.max !== undefined) parts.push('≤' + e.max);
    return parts.length ? parts.join(' 且 ') : '(未指定)';
  }
  return String(e);
}

/**
 * 判定单个目标。
 * @param {Object} target - {label?, selector?|ref?|role?+name?|testid?|text?, index?, expect?}
 * @param {Object|null} state - 扩展返回的渲染态（{found,count,visible,text,value,box,styles,selector,tag}）
 * @returns {{index:number,label:string,pass:boolean,found:boolean,locator:string,observed:Object,checks:Array,reason:string}}
 */
export function checkTarget(target, state) {
  const t = target || {};
  const rawExpect = t.expect && typeof t.expect === 'object' ? Object.assign({}, t.expect) : {};
  const hasExpect = Object.keys(rawExpect).length > 0;
  if (!hasExpect) rawExpect.present = true; // 默认断言：元素存在
  if (rawExpect.absent === true) {
    rawExpect.present = false;
    delete rawExpect.absent;
  }

  const st = state || {};
  const found = st.found === true;
  const checks = [];
  const add = (name, expected, actual, ok) => checks.push({ name, expected, actual, ok });

  const locator = describeLocator(t);
  const label = normalizeText(t.label) || locator;

  // 不依赖元素存在性的断言。
  if (rawExpect.present !== undefined) {
    add('present', Boolean(rawExpect.present), found, Boolean(rawExpect.present) === found);
  }
  if (rawExpect.count !== undefined) {
    const e = rawExpect.count;
    const n = Number(st.count) || 0;
    let ok;
    if (e && typeof e === 'object') {
      ok = true;
      if (e.min !== undefined && n < Number(e.min)) ok = false;
      if (e.max !== undefined && n > Number(e.max)) ok = false;
    } else {
      ok = n === Number(e);
    }
    add('count', formatCountExpect(e), n, ok);
  }

  // 依赖元素存在性的断言：元素不存在时一律记失败，并如实说明「元素不存在」。
  const need = (name, expected, actualFn, passFn) => {
    if (!found) {
      add(name, expected, '元素不存在', false);
      return;
    }
    const actual = actualFn();
    add(name, expected, actual, passFn(actual));
  };

  if (rawExpect.visible !== undefined) {
    need(
      'visible',
      Boolean(rawExpect.visible),
      () => st.visible === true,
      (actual) => actual === Boolean(rawExpect.visible)
    );
  }
  if (rawExpect.text !== undefined) {
    const want = normalizeText(rawExpect.text);
    need('text', want, () => normalizeText(st.text), (actual) => actual.includes(want));
  }
  if (rawExpect.textEquals !== undefined) {
    const want = normalizeText(rawExpect.textEquals);
    need('textEquals', want, () => normalizeText(st.text), (actual) => actual === want);
  }
  if (rawExpect.value !== undefined) {
    const want = String(rawExpect.value);
    need('value', want, () => String(st.value === undefined ? '' : st.value), (actual) => actual.includes(want));
  }
  if (rawExpect.minWidth !== undefined) {
    const want = Number(rawExpect.minWidth);
    need('minWidth', want, () => (st.box ? Number(st.box.w) || 0 : 0), (actual) => actual >= want);
  }
  if (rawExpect.minHeight !== undefined) {
    const want = Number(rawExpect.minHeight);
    need('minHeight', want, () => (st.box ? Number(st.box.h) || 0 : 0), (actual) => actual >= want);
  }
  if (rawExpect.styles && typeof rawExpect.styles === 'object') {
    for (const prop of Object.keys(rawExpect.styles)) {
      const want = String(rawExpect.styles[prop]);
      need(
        'style:' + prop,
        want,
        () => String((st.styles && st.styles[prop]) || ''),
        (actual) => actual.includes(want)
      );
    }
  }

  const pass = checks.length > 0 && checks.every((c) => c.ok);

  // 失败原因：优先指出未找到元素（最常见），否则列出第一条不匹配的断言。
  let reason = '';
  if (!pass) {
    const failedList = checks.filter((c) => !c.ok);
    if (!found) {
      reason =
        '未找到元素（' + locator + '）。可能原因：选择器因改动而失效、元素被条件渲染移除、或 HMR 尚未完成。' +
        '建议先等待/刷新，或调用 get_element_source / get_page_snapshot 重新确认定位。';
    } else if (failedList.length) {
      const f = failedList[0];
      reason =
        '断言「' + f.name + '」未通过：期望 ' + JSON.stringify(f.expected) + '，实际 ' + JSON.stringify(f.actual) + '（' + locator + '）。';
    }
  }

  return {
    index: t.index === undefined ? undefined : t.index,
    label,
    locator,
    pass,
    found,
    observed: {
      selector: st.selector || '',
      tag: st.tag || '',
      count: Number(st.count) || 0,
      visible: st.visible === true,
      text: st.text === undefined ? '' : String(st.text),
      value: st.value === undefined ? '' : String(st.value),
      box: st.box || null,
      styles: st.styles || null,
    },
    checks,
    reason,
  };
}

/**
 * 批量判定。
 * @param {Array} targets - 目标声明数组（与传给扩展的顺序一致）
 * @param {Array} states - 扩展返回的渲染态数组（同序）
 */
export function evaluateTargets(targets, states) {
  const list = Array.isArray(targets) ? targets : [];
  const observed = Array.isArray(states) ? states : [];
  const results = list.map((t, i) => checkTarget(t, observed[i] || null));
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  let summary;
  if (!results.length) {
    summary = '没有需要验证的目标：请先 dev_session_set 写入 targets，或在本工具直接传 targets。';
  } else if (failed === 0) {
    summary = '全部 ' + results.length + ' 个目标验证通过。';
  } else {
    summary = passed + ' / ' + results.length + ' 个目标验证通过，' + failed + ' 个未通过。';
  }
  return { results, passed, failed, summary };
}
