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
import { archive } from './evidence-store.js';

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

/** 游标按「标签页」分组（与桥接的 healthCursorByTab 同一规则）：切页不会串台。 */
export function toolCursorKey(raw) {
  return String((raw && (raw.tabId || raw.pageUrl)) || 'default');
}

/**
 * 一站式：把扩展的原始结果按方法加工成给模型看的形状。
 *
 * 有状态的两个方法（page_health / verify_change）**不在这里存游标** ——
 * 调用方通过 opts 传入当前的 cursor，并用 onCursor 接收推进后的值。
 * 这样桥接与插件各自持有自己的游标（语义是"自我上次检查以来"），
 * 却共用同一份加工逻辑。
 *
 * @returns {{result:any, cursor:(string|undefined)}}
 */
function computeToolResult(name, raw, ctx, opts = {}) {
  const stateless = normalizeToolResult(name, raw, ctx);
  if (stateless) return { result: stateless, cursor: undefined };

  // browser_read 走"归档 + 成形"（会写证据库，因此不在 normalizeToolResult 里）
  if (name === 'browser_read') {
    return { result: shapeBrowserReadResult(raw, opts.fallbackUrl), cursor: undefined };
  }

  if (name === 'page_health') {
    const r = shapePageHealthResult(raw, ctx, {
      cursor: opts.cursor,
      since: opts.since,
      levels: opts.levels,
      limit: opts.limit,
    });
    if (opts.onCursor && r.cursor !== opts.cursor) opts.onCursor(r.cursor);
    return { result: r.result, cursor: r.cursor };
  }

  if (name === 'verify_change') {
    const r = shapeVerifyChangeResult(raw, ctx, opts.targets, {
      targetsFromArgs: opts.targetsFromArgs === true,
      cursor: opts.cursor,
      since: opts.since,
      levels: opts.levels,
      limit: opts.limit,
    });
    if (opts.onCursor && r.cursor !== opts.cursor) opts.onCursor(r.cursor);
    return { result: r.result, cursor: r.cursor };
  }

  // 其余方法（screenshot_capture / handoff_* …）：原样返回。
  return { result: raw, cursor: undefined };
}

/**
 * 对外的一站式入口：算完之后统一过一遍 stripUndefined。
 *
 * 分成两层是因为"无损 JSON"是**出口的约束**，不是每个成形函数的职责 ——
 * 放在出口只需要写一次，也不会因为某个成形函数以后新增了 `|| undefined` 而失效。
 */
export function applyToolResult(name, raw, ctx, opts = {}) {
  const out = computeToolResult(name, raw, ctx, opts);
  return { result: stripUndefined(out.result), cursor: out.cursor };
}
/**
 * 解出 verify_change 要用的 targets：本次调用优先，其次来自 dev-session。
 * 与桥接里原来的判断**逐字一致**（包括那条"没有可验证目标"的报错文案）。
 * @returns {{targets:Array, fromArgs:boolean, error:(string|null)}}
 */
export function resolveTargets(argsTargets, session) {
  const fromArgs = Array.isArray(argsTargets) && argsTargets.length ? argsTargets : null;
  const targets = fromArgs || (session && Array.isArray(session.targets) ? session.targets : []);
  if (!targets.length) {
    return {
      targets: [],
      fromArgs: false,
      error:
        '没有可验证的目标。请先用 dev_session_set 写入 targets（例如 ' +
        '[{selector:"#submit", expect:{text:"已提交"}}]），或在本次调用直接传 targets。',
    };
  }
  return { targets, fromArgs: Boolean(fromArgs), error: null };
}

/**
 * 递归剔除 `undefined` 属性、把非有限数字换成 null —— 让结果成为**无损 JSON**。
 *
 * 为什么需要：DSH 的工具返回值必须能无损往返（`JSON.parse(JSON.stringify(v))` 等于 v），
 * 否则它直接报 `value is not lossless JSON` 并**拒绝整次工具调用**。
 * 实测踩到：page_health 因为 `consoleError: r.consoleError || undefined` 这个显式
 * undefined 属性而整条失败 —— 而桥接（MCP）从不会有这个问题（它序列化成 JSON 文本，
 * undefined 属性本来就会被丢掉）。所以这是**插件这条路独有的约束**。
 *
 * 放在统一出口处理，而不是让每个成形函数各自小心 —— 后者迟早会漏。
 */
export function stripUndefined(value, depth = 0) {
  if (depth > 12) return value; // 防御：异常深的嵌套不做无限递归
  // 数组：**不能**简单 map —— 数组里的 undefined 会被 JSON.stringify 变成 null，
  // 于是往返不等（[1,undefined] → "[1,null]"）。显式换成 null 才无损（不丢下标）。
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : stripUndefined(v, depth + 1)));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      const v = value[k];
      if (v === undefined) continue;
      out[k] = stripUndefined(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

/**
 * browser_read：**归档**并成形。
 *
 * 这是"只在桥接里存在"的第二个能力（第一个是源位置重写）：
 * 桥接原来在这里 `archive(...)`，返回 fetchedAt / snapshotHash；插件的工具却直接返回
 * 扩展的原始 {url,title,text,quotes} —— 而**工具描述里明确承诺了那两个字段**。
 * 不共享的话，删掉 DSH 的 MCP client 之后那份描述就是假的。
 *
 * URL 校验也放在这里（桥接原来在调用前校验，扩展侧也会校验一遍）：
 * 一份实现胜过两处各写一遍。校验失败**抛错** —— 与桥接原行为一致。
 */
export function shapeBrowserReadResult(raw, fallbackUrl) {
  const url = String(((raw && raw.url) || fallbackUrl || '')).trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('browser_read 仅支持 http/https URL');
  const rec = archive({
    url,
    title: raw && raw.title,
    text: raw && raw.text,
    quotes: raw && raw.quotes,
  });
  return {
    ok: true,
    url: rec.url,
    title: rec.title,
    fetchedAt: rec.fetchedAt,
    snapshotHash: rec.snapshotHash,
    text: rec.text,
    quotes: rec.quotes,
  };
}

/** 把 args.cursor 的三种形态（未给 / 'all' / 具体值）归一成 shapePageHealth/VerifyChange 要的形式。 */
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
