// Reversible page overlays, scrolling and style mutations.
import {
  buildPageCharMap,
  findRangeBySubstr,
  overlayElement,
  overlayColor,
  overlayRange,
  disposeOverlays,
} from '../citation.ts';
import {
  findElementsFor,
  findRangeFor,
  targetMissError,
} from './locator.ts';
import { elementSelector } from '../page-text.ts';
import { HIGHLIGHT_MAX_TEXTS } from '../../../shared/constants.ts';
import { formatHighlightResult } from '../../../shared/format/page-results.ts';
import { pageCommandSession } from './session.ts';

function scrollRangeIntoView(range: any) {
  const rect = range.getBoundingClientRect();
  if (rect && rect.height) {
    window.scrollTo({ top: Math.max(0, window.scrollY + rect.top - window.innerHeight * 0.38), behavior: 'smooth' });
  } else {
    const el = range.startContainer.parentElement;
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function cmdHighlight(params: any) {
  const color = params.color || overlayColor();
  // 批量模式：一次调用高亮多个文本片段（texts 数组），避免逐条调用浪费 Agent 轮次。
  if (params.texts && Array.isArray(params.texts)) {
    const requested = params.texts.map((t: any) => String(t).trim()).filter(Boolean);
    // 单次上限是性能护栏（每条都要建字符映射 + 落一层浮层），但不能**默默**截断。
    // 原实现先 slice(0, 20) 再报 texts.length，于是传 25 条会返回
    // 「已高亮 20 / 20 处关键信息」—— 调用方以为 25 条全做了。
    // 这和一个上限被当成答案同样危险：它让「少做了 5 条」看起来像「全部完成」。
    const texts = requested.slice(0, HIGHLIGHT_MAX_TEXTS);
    if (!texts.length) return { ok: false, error: 'texts 数组为空或全部为空串' };
    const map = buildPageCharMap();
    let hit = 0;
    const misses = [];
    for (const t of texts) {
      const range = findRangeBySubstr(map, t);
      if (range) {
        overlayRange(range, color, 'cmd');
        hit += 1;
      } else {
        misses.push(t);
      }
    }
    if (!hit) return { ok: false, error: '未在页面中找到任何待高亮文本' };
    return {
      ok: true,
      hit,
      attempted: texts.length,
      requested: requested.length,
      result: formatHighlightResult({
        hit,
        attempted: texts.length,
        requested: requested.length,
        misses,
        limit: HIGHLIGHT_MAX_TEXTS,
      }),
    };
  }
  if (params.text) {
    const range = findRangeFor(params);
    if (!range) return { ok: false, error: '未在页面中找到文本：' + params.text };
    overlayRange(range, color, 'cmd');
    // 高亮时不自动滚动页面，避免连续高亮多条关键句时页面反复跳动；
    // 需要定位时请用 scroll_page 或点击引用徽章。
    return { ok: true, result: '已高亮文本' };
  }
  if (params.selector) {
    const els = findElementsFor(params);
    if (!els.length) return { ok: false, error: '未找到选择器匹配元素：' + params.selector };
    els.forEach((el) => overlayElement(el, color, false, 'cmd'));
    return { ok: true, result: '已高亮 ' + els.length + ' 个元素' };
  }
  return { ok: false, error: 'highlight 需要 texts、text 或 selector 参数' };
}

function cmdScrollTo(params: any) {
  const behavior = params.behavior === 'auto' ? 'auto' : 'smooth';
  const block = params.block || 'start';
  const beforeX = window.scrollX;
  const beforeY = window.scrollY;
  const pushScrollUndo = () => pageCommandSession.pushUndo(() => window.scrollTo(beforeX, beforeY));
  if (params.ref || params.text || params.selector) {
    // ⚠ 给 **x/y 偏移** 时，滚的是**这个元素自己**，不是窗口。
    //
    // 修的是一个真实的能力缺口：**内部可滚动容器**（虚拟列表 / 带 overflow 的面板）
    // 原先没有任何一等公民的滚法 ——
    //   · `{ selector }` 走 scrollIntoView，对已经在视口里的容器是**空操作**，`y` 被直接忽略；
    //   · 不带目标时走 `scroll_by`，那是 `window.scrollBy`，**只动窗口**。
    // 于是"把容器滚到第 87 条"只能靠反复 scrollIntoView 可见行慢慢推，
    // 或者用 run_javascript 自己设 scrollTop（一次高危审批）。
    // 现在 `scroll_page({ selector: '#list', y: 3480 })` = "把该容器向下滚 3480px"，
    // 与 schema 里 `y` 的既有描述（"纵向偏移(px)，正数向下"）一致。
    const offY = Number(params.y) || 0;
    const offX = Number(params.x) || 0;
    if (offY || offX) {
      const target = (params.ref || params.selector) ? findElementsFor(params)[0] : null;
      const range = !target && params.text ? findRangeFor(params) : null;
      const box = target || (range && (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement));
      if (!box) {
        return { ok: false, error: targetMissError(params) + '（可先 get_page_snapshot 获取 ref，或改用 role/name 定位）' };
      }
      const prevTop = box.scrollTop;
      const prevLeft = box.scrollLeft;
      box.scrollTop = prevTop + offY;
      box.scrollLeft = prevLeft + offX;
      pageCommandSession.pushUndo(() => {
        box.scrollTop = prevTop;
        box.scrollLeft = prevLeft;
      });
      const moved = Math.round(box.scrollTop) !== Math.round(prevTop) || Math.round(box.scrollLeft) !== Math.round(prevLeft);
      return {
        ok: true,
        selector: elementSelector(box),
        result:
          '已滚动容器（偏移 y=' + offY + ' x=' + offX + '）→ scrollTop=' + Math.round(box.scrollTop) +
          ' scrollLeft=' + Math.round(box.scrollLeft) +
          (moved ? '' : '（位置没变：该元素可能本来就不可滚动，或已经到边界）'),
      };
    }
    if (params.text) {
      const range = findRangeFor(params);
      if (range) {
        scrollRangeIntoView(range);
        pushScrollUndo();
        return { ok: true, result: '已滚动到目标文本' };
      }
    }
    const els = findElementsFor(params);
    if (!els.length) return { ok: false, error: targetMissError(params) + '（可先 get_page_snapshot 获取 ref，或改用 role/name 定位）' };
    els[0].scrollIntoView({ behavior, block });
    pushScrollUndo();
    return { ok: true, selector: elementSelector(els[0]), result: '已滚动到目标元素' };
  }
  if (typeof params.top === 'number' || typeof params.left === 'number') {
    window.scrollTo({ top: Number(params.top) || 0, left: Number(params.left) || 0, behavior });
    pushScrollUndo();
    return { ok: true, result: '已滚动到指定位置' };
  }
  return { ok: false, error: 'scroll_to 需要 ref/text/selector 或 top/left 参数' };
}

function cmdScrollBy(params: any) {
  const beforeX = window.scrollX;
  const beforeY = window.scrollY;
  window.scrollBy({
    top: Number(params.y) || 0,
    left: Number(params.x) || 0,
    behavior: params.behavior === 'auto' ? 'auto' : 'smooth',
  });
  pageCommandSession.pushUndo(() => window.scrollTo(beforeX, beforeY));
  return { ok: true, result: '已滚动' };
}

function cmdOutline(params: any) {
  const color = params.color || '#ff5722';
  const els = findElementsFor(params);
  if (!els.length) return { ok: false, error: targetMissError(params) };
  // 用独立 owner 管理本批次描边，duration 到后整体清理；描边同样滚动跟随。
  const owner = 'cmd-outline-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  els.forEach((el) => overlayElement(el, color, true, owner));
  els[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  const dur = Math.max(0, Number(params.duration) || 1500);
  const t = setTimeout(() => {
    disposeOverlays(owner);
  }, dur);
  pageCommandSession.addTimer(t);
  return { ok: true, result: '已描边 ' + els.length + ' 个元素' };
}

function cmdSetStyle(params: any) {
  // hide 语法糖：隐藏是最高频用法，且比「从 DOM 移除」安全得多
  // （移除节点会让站点自身的状态跟踪失准：无限滚动、内容可见性、广告 SDK 都会报错）。
  const hide = params.hide;
  let styles = params.styles;
  if (hide === true) styles = { display: 'none' };
  else if (hide === false) styles = { display: '' };
  if (!styles || typeof styles !== 'object' || Array.isArray(styles)) {
    return { ok: false, error: 'set_style 需要 styles 对象，或直接用 hide:true 隐藏 / hide:false 还原' };
  }

  // 批量：一次处理多个选择器。没有批量参数时，「隐藏 N 个元素」= N 次工具调用，
  // 模型会倾向改用 run_javascript 写循环 —— 而循环里往往顺手 remove() 掉节点。
  const selectorList = Array.isArray(params.selectors)
    ? params.selectors.map((s: any) => String(s === undefined || s === null ? '' : s).trim()).filter(Boolean).slice(0, 20)
    : [];

  let els: any[] = [];
  const misses = [];
  if (selectorList.length) {
    for (const sel of selectorList) {
      let hit = [];
      try {
        hit = findElementsFor({ selector: sel });
      } catch (e: any) {
        hit = [];
      }
      if (hit.length) els = els.concat(hit);
      else misses.push(sel);
    }
    els = Array.from(new Set(els)); // 同一元素可能同时匹配多个选择器
    if (!els.length) {
      return { ok: false, error: '未找到任何目标元素（全部未命中：' + misses.join('、') + '）' };
    }
  } else {
    els = findElementsFor(params);
    if (!els.length) return { ok: false, error: targetMissError(params) };
  }

  const backups = els.map((el) => ({ el, old: el.style.cssText }));
  els.forEach((el) => {
    Object.keys(styles).forEach((k) => {
      try { el.style[k] = styles[k]; } catch (e: any) {}
    });
  });
  const revert = () => backups.forEach((b) => { b.el.style.cssText = b.old; });
  pageCommandSession.pushUndo(revert);

  const verb = hide === true ? '隐藏' : hide === false ? '还原' : '修改';
  const missNote = misses.length
    ? '；未命中 ' + misses.length + ' 个选择器：' + misses.map((m) => m.slice(0, 24)).join('、')
    : '';
  const tail = '（' + (Number(params.duration) > 0 ? Number(params.duration) + 'ms 后还原' : 'clear_highlights 还原') + '）';
  const summary = '已' + verb + ' ' + els.length + ' 个元素' + missNote + tail;

  const dur = Number(params.duration);
  if (dur > 0) {
    pageCommandSession.addTimer(setTimeout(revert, dur));
    return { ok: true, result: summary, changed: true, alreadySatisfied: false };
  }
  pageCommandSession.addStyleReverter(revert);
  return { ok: true, result: summary, changed: true, alreadySatisfied: false };
}

export const highlight = cmdHighlight;
export const scrollTo = cmdScrollTo;
export const scrollBy = cmdScrollBy;
export const outline = cmdOutline;
export const setStyle = cmdSetStyle;
