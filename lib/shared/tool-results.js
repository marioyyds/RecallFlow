/**
 * 扩展返回的原始结果 → 给模型看的形状（**共享**）。
 *
 * 为什么必须共享：桥接与 DSH 插件都会拿到扩展的同一个原始结果，
 * 而「源位置重写」「元素源码成形」这些加工**只在桥接里做过** ——
 * 于是插件的 recallflow_browser 返回的是未加工的原始 JSON（没有磁盘路径、没有 hint）。
 * 删掉 DSH 的 MCP client 就会静默失去「元素 → 源码文件」这个能力。
 *
 * 这里只放**无状态**的方法。`page_health` / `verify_change` 依赖调用方自己的
 * 增量游标（语义是"自**我**上次检查以来"），所以由调用方组合
 * `summarizePageHealth` / `evaluateTargets`，不塞进本模块。
 *
 * 形状与桥接里原有的实现**逐字一致** —— 这不是重新设计，是搬家。
 */
import {
  normalizeElementSource,
  normalizePickedElement,
  normalizationHint,
  rewriteSourceUrls,
} from './dev-paths.js';
import { summarizePageHealth } from './page-health.js';
import { evaluateTargets } from './verify-change.js';

/** read_console / read_network：文本里的源码 URL（调用栈、initiator）→ 磁盘路径。 */
export function shapeTextResult(raw, ctx) {
  return { ok: true, text: rewriteSourceUrls((raw && raw.text) || '', ctx || {}) };
}

/**
 * get_element_source：结构化成形。
 * 直接处理 source 对象，不再按「元素源码位置：」文案反解。
 */
export function shapeElementSourceResult(raw, ctx) {
  if (!raw || raw.found === false) {
    return {
      ok: false,
      found: false,
      reason: (raw && raw.reason) || '未找到元素或框架源码信息（可能不是 React/Vue/Svelte 开发构建）。',
    };
  }
  const src = normalizeElementSource(raw.source, ctx);
  if (!src) {
    return { ok: false, found: false, reason: '该元素没有可用的框架源码信息。' };
  }
  const loc =
    String(src.file || '') + (src.line ? ':' + src.line + (src.column ? ':' + src.column : '') : '');
  const text =
    '元素源码位置：' +
    loc +
    (src.framework ? '（' + src.framework + (src.component ? ' · ' + src.component : '') + '）' : '') +
    (raw.selector ? '\n选择器：' + raw.selector : '');
  // 只有「没能转换」时才提示补 dev_session；原值已可对照时不必打扰。
  const hint = src.originalFile ? '' : normalizationHint(ctx);
  return {
    ok: true,
    found: true,
    file: src.file || '',
    line: src.line || 0,
    column: src.column || 0,
    framework: src.framework || '',
    component: src.component || '',
    selector: raw.selector || '',
    originalFile: src.originalFile || '',
    text,
    hint: hint || undefined,
  };
}

/** get_picked_element：该接口返回结构化对象（含 source.file），按字段归一化比改写文本可靠。 */
export function shapePickedElementResult(raw, ctx) {
  if (!raw) return { found: false };
  return normalizePickedElement(raw, ctx);
}

/**
 * 按方法名分派上面这些**无状态**的成形。
 * 返回 null 表示"这个方法不由本模块负责"（调用方自己处理，例如 page_health / verify_change）。
 */
export function normalizeToolResult(name, raw, ctx) {
  switch (name) {
    case 'read_console':
    case 'read_network':
      return shapeTextResult(raw, ctx);
    case 'get_element_source':
      return shapeElementSourceResult(raw, ctx);
    case 'get_picked_element':
      return shapePickedElementResult(raw, ctx);
    default:
      return null;
  }
}

/** 把 args.cursor 的三种形态（未给 / 'all' / 具体值）归一成下面两个函数要的形式。 */
export function cursorOverrideFrom(args) {
  const explicit = args ? args.cursor : undefined;
  if (explicit === undefined || explicit === null) return undefined;
  return String(explicit) === 'all' ? '' : String(explicit);
}

/**
 * page_health 的增量摘要。
 *
 * **cursor 由调用方持有**：它的语义是"自**我**上次检查以来"，两个消费者各自推进才正确
 * （共享会让一方的检查吃掉另一方的增量）。因此这里返回 { result, cursor }，
 * 由调用方把 cursor 存回自己的位置 —— 而不是在本模块里放一个全局 Map。
 */
export function shapePageHealthResult(raw, ctx, opts = {}) {
  const base = { cursor: opts.cursor === undefined ? '' : opts.cursor };
  if (!raw || raw.found === false) {
    return Object.assign(base, {
      result: { ok: false, error: '未找到活动标签页：请先切到要调试的页面再调用 page_health。' },
    });
  }
  const health = summarizePageHealth({
    consoleEntries: raw.console,
    networkEntries: raw.network,
    cursor: opts.cursor || '',
    since: opts.since,
    levels: opts.levels,
    limit: opts.limit,
    projectRoot: (ctx && ctx.projectRoot) || '',
    devUrl: (ctx && ctx.devUrl) || '',
  });
  const hint = normalizationHint(ctx);
  const result = Object.assign(
    {
      ok: true,
      tabId: raw.tabId,
      pageUrl: raw.pageUrl,
      pageTitle: raw.pageTitle,
      consoleError: raw.consoleError || undefined,
      networkError: raw.networkError || undefined,
    },
    health,
    hint ? { hint } : {}
  );
  return { result, cursor: health.cursor || opts.cursor || '' };
}

/**
 * verify_change：目标元素的断言求值 + 增量新问题。
 * targets 与 cursor 都由调用方提供（targets 可能来自本次调用，也可能来自 dev-session）。
 */
export function shapeVerifyChangeResult(raw, ctx, targets, opts = {}) {
  const fromArgs = opts.targetsFromArgs === true;
  if (!raw || raw.found === false) {
    return {
      result: { ok: false, error: '未找到活动标签页：请先切到要调试的页面再调用 verify_change。' },
      cursor: opts.cursor || '',
    };
  }
  const evaluated = evaluateTargets(targets, raw.targets);
  const health = summarizePageHealth({
    consoleEntries: raw.console,
    networkEntries: raw.network,
    cursor: opts.cursor || '',
    since: opts.since,
    levels: opts.levels,
    limit: opts.limit,
    projectRoot: (ctx && ctx.projectRoot) || '',
    devUrl: (ctx && ctx.devUrl) || '',
  });
  const hint = normalizationHint(ctx);
  const result = Object.assign(
    {
      ok: true,
      tabId: raw.tabId,
      pageUrl: raw.pageUrl,
      pageTitle: raw.pageTitle,
      targetsSource: fromArgs ? 'call-args' : 'dev-session',
      targets: evaluated.results,
      passed: evaluated.passed,
      failed: evaluated.failed,
      summary: evaluated.summary,
      newIssues: {
        summary: health.summary,
        errors: health.errors,
        warnings: health.warnings,
        failedRequests: health.failedRequests,
      },
      targetsError: raw.targetsError || undefined,
    },
    hint ? { hint } : {}
  );
  return { result, cursor: health.cursor || opts.cursor || '' };
}
