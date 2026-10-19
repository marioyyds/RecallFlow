// 宏类工具（save_macro / list_macros / run_macro）→ 收敛为 macro(op)。
//
// C-4 合并第 5 档（见 docs/tool-merge-plan.md）。选它是因为：三个 handler 都很短（15–22 行）、
// 引用密度在候选里最低，且逐档核对"跨越性约束"后确认没有能力前置条件冲突。
//
// ⚠ **合并后必须按 op 分别保留两条防线**（这不是形式主义，有真实提权先例）：
//   1. `op=save` 需要审批（写操作，risk 从 read 提升为 write）；
//   2. `op=run` 必须过**执行期** `REPLAYABLE_TOOLS` 白名单。
// 关于第 2 条：`REPLAYABLE_TOOLS` 原先只在**记录时**生效，回放时从不检查。
// 而宏是持久化在 chrome.storage.local 的 JSON —— 任何能写该键的一方都能塞进
// `{tool:'run_javascript', args:{code:'…'}}`，回放路径直接 executeTool，
// 于是 run_javascript 的页面命令审批被完全绕过：
// 用户只需批准一次普通的 run_macro（risk:'page'，可按类别自动批准）。
// 顺带，run_macro 本身不在白名单里，因此嵌套回放（递归）也被同一条挡住。
// 合并成一个入口后，这条检查**必须原样留在 op=run 分支上**。
// `tests/tool-merge-plan.test.mjs` 把它写成了断言。
//
// 另一处**有意**的行为：`op=save` 的轨迹可以来自**上一轮任务**（`deps.recallTrace`）。
// 起因是会话 RF-FY6PUP 的真实故障：用户在流程跑完的**下一轮**才说「沉淀为技能」，
// 而 ctx.trace 只活在单次运行里 ⇒ 只会回「没有可保存的动作」，用户看到的是"存不了宏"。
// 回退轨迹的 TTL 由 macro-store.js 把关（过期的轨迹不许回放），
// 且**用它存出来的宏必须在结果里标明来源不是本轮**（见 macroSave 的 source 文案）。

import { containsLikelySecret, redactSensitiveText } from '../shared/sensitive-data.js';

/** 可回放的工具白名单（新增可回放工具时必须同时改这里与 buildInitialMessages 的说明）。 */
export const REPLAYABLE_TOOLS = new Set([
  'click_element', 'type_text', 'press_key', 'select_option', 'check_box',
  'scroll_page', 'wait_for_element', 'open_tab',
]);

/**
 * 保存当前任务的可重放动作为宏。
 *
 * 两个轨迹来源（**来源必须如实回报**，见下面的文案）：
 *   1. 本轮 `deps.trace`（首选）；
 *   2. 本轮为空时，回退到**本站点最近一次**的可重放轨迹（`deps.recallTrace`，TTL 由
 *      macro-store 把关）。为什么要有第 2 条：用户说「沉淀下来」常常在**下一轮**才说
 *      （实测 RF-FY6PUP），而本轮 trace 天然是空的 —— 没有回退就只剩"存不了"。
 *
 * @param {object} deps { pageUrl, trace, saveMacro, recallTrace? }
 */
export async function macroSave(deps, args) {
  const name = String((args && args.name) || '').trim();
  if (!name) return { ok: false, result: 'macro(op="save") 需要 name。' };
  let trace = Array.isArray(deps.trace) ? deps.trace : [];
  let fromPreviousRun = false;
  let previousAgeMs = 0;
  let previousDropped = 0;
  if (!trace.length && typeof deps.recallTrace === 'function') {
    // 用 then 包一层：recallTrace 若**同步**抛错（例如 stub 里写错），
    // 直接 `Promise.resolve(deps.recallTrace(...))` 会先在求值时炸掉，回退就失效了。
    const last = await Promise.resolve().then(() => deps.recallTrace(deps.pageUrl)).catch(() => null);
    if (last && Array.isArray(last.steps) && last.steps.length) {
      trace = last.steps;
      fromPreviousRun = true;
      previousAgeMs = Number(last.ageMs) || 0;
      previousDropped = Number(last.dropped) || 0;
    }
  }
  // 无论来源，落库前都过一遍**执行期白名单**（唯一来源仍是 REPLAYABLE_TOOLS）：
  // 本轮 trace 由 recordTraceStep 保证过，但回退轨迹来自**另一个 storage 键** ——
  // 任何能写该键的一方都能塞进任意工具名，而宏一旦落库就会被反复回放。
  // 回放期 `macroRun` 还有第二道同样的检查；两道都保留（理由见文件头：曾有真实提权）。
  const beforeFilter = trace.length;
  trace = trace.filter((s) => {
    if (!s || typeof s.tool !== 'string' || !s.args || typeof s.args !== 'object' || !REPLAYABLE_TOOLS.has(s.tool)) return false;
    const raw = JSON.stringify(s);
    return !containsLikelySecret(raw) && redactSensitiveText(raw) === raw;
  });
  const skipped = beforeFilter - trace.length;
  if (!trace.length) {
    // 报错必须给"下一步怎么做"，而不是只说"没有"（同文件 macroRun 的报错纪律）。
    return {
      ok: false,
      result:
        (skipped > 0
          ? '这一批轨迹里有 ' + skipped + ' 步都不在可回放白名单内（已剔除），没有可保存的步骤。\n'
          : '本轮任务没有可保存的可重放动作，本站点也没有最近可沉淀的轨迹。\n') +
        '只有这些工具会被记录：' + Array.from(REPLAYABLE_TOOLS).join('、') +
        '（且需要拿到稳定的 selector）；`click_at`（坐标点击）与 `run_javascript` **不进宏**。\n' +
        '要沉淀成宏：请用上面这些工具把流程完整做一遍，**做完立刻** macro({op:"save", name:"…"})。',
    };
  }
  const saved = await deps.saveMacro(deps.pageUrl, { name, description: args && args.description, steps: trace });
  if (!saved) return { ok: false, result: '保存宏失败（缺少名称或步骤）。' };
  // 来源不是本轮时**必须说出来**：否则模型会以为"刚刚录的"，而用户问的可能是更早的流程；
  // 回放一个来路不明的序列是有副作用的操作，先让它核对再回放。
  const source = fromPreviousRun
    ? '⚠ 这 ' + saved.steps.length + ' 步来自**上一轮任务**在本站点的轨迹（约 ' +
      Math.max(1, Math.round(previousAgeMs / 60000)) + ' 分钟前），不是本轮。' +
      (previousDropped > 0 ? '另有 ' + previousDropped + ' 步因超长未纳入。' : '') +
      '回放前请先核对步骤是否符合预期（macro({op:"list"})，或先试跑一次）。'
    : '';
  const droppedNote = skipped > 0 ? '（另有 ' + skipped + ' 步不在可回放白名单内，已剔除）' : '';
  return {
    ok: true,
    result:
      '已保存宏「' + saved.name + '」（' + saved.steps.length + ' 步）。' + droppedNote + source +
      '以后可用 macro({op:"run", name:"' + saved.name + '"}) 回放。',
  };
}

/** 列出当前站点已保存的宏。 */
export async function macroList(deps) {
  const macros = await deps.listMacros(deps.pageUrl);
  if (!macros.length) return { ok: true, result: '当前站点还没有保存的宏。' };
  const text = macros
    // 名字必须**显式引号标出**：原先写成 `名字：描述（N 步）`，而名字与描述都用 `：`
    // 分隔，名字里本身也可能含 `：`，于是边界真的有歧义。实测（会话 RF-EGPWWF）
    // agent 依次试了整行、试了描述，第三次才对 —— 两次调用纯属浪费。
    .map((m, i) => '[' + (i + 1) + '] name="' + m.name + '"' + (m.description ? ' — ' + m.description : '') + '（' + m.steps.length + ' 步）')
    .join('\n');
  return { ok: true, result: '当前站点已保存的宏（回放时请照抄 name 的值）：\n' + text };
}

/**
 * 回放一个宏。
 *
 * @param {object} deps { pageUrl, ctx, getMacro, listMacros, bumpMacroHits, executeTool, validateToolCall }
 *   `ctx` 会被就地更新（tabId/pageUrl/pageTitle）——宏中途开新标签页后，后续步骤要在新页上执行。
 */
export async function macroRun(deps, args) {
  const name = String((args && args.name) || '').trim();
  if (!name) return { ok: false, result: 'macro(op="run") 需要 name。' };
  const macro = await deps.getMacro(deps.pageUrl, name);
  if (!macro) {
    // 报错必须给出**可用候选**。「可用 list 查看」等于把活推回给调用方 ——
    // 它刚刚就是看着列表试错的（实测连错两次）。这里直接列出准确的 name。
    let names = [];
    try {
      names = (await deps.listMacros(deps.pageUrl)).map((m) => m.name);
    } catch (e) {}
    return {
      ok: false,
      result:
        '未找到宏「' + name + '」。' +
        (names.length
          ? '本站可用的宏名如下，请照抄 name 的值（不是描述）：\n' + names.map((n) => '  - ' + n).join('\n')
          : '本站还没有保存的宏。'),
    };
  }
  const steps = Array.isArray(macro.steps) ? macro.steps : [];
  if (!steps.length) return { ok: false, result: '宏「' + name + '」没有步骤。' };
  const ctx = deps.ctx;
  const log = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    // ↓↓↓ 执行期白名单：这是修一个提权路径，不是防御性编程。理由见文件头注释。
    if (!REPLAYABLE_TOOLS.has(s && s.tool)) {
      const toolName = String((s && s.tool) || '');
      return {
        ok: false,
        result:
          '宏「' + name + '」的第 ' + (i + 1) + ' 步调用了不允许回放的工具「' + toolName + '」，已停止。\n' +
          '只有这些工具可以被宏回放：' + Array.from(REPLAYABLE_TOOLS).join('、') + '。\n' +
          '若确实需要该操作，请改用对应的内置工具单独执行（高风险工具仍需逐次审批）。',
      };
    }
    // 步骤参数也要过一次校验：宏是外部可写数据，缺参/形状错误应给出可读原因，
    // 而不是让 executeTool 在深处抛出难以归因的异常。
    const stepValidation = deps.validateToolCall(s.tool, s.args || {});
    if (!stepValidation.ok) {
      return {
        ok: false,
        result: '宏「' + name + '」的第 ' + (i + 1) + ' 步参数非法：' + stepValidation.error,
      };
    }
    let r;
    try {
      r = await deps.executeTool(s.tool, s.args, ctx);
    } catch (e) {
      r = { ok: false, result: e && e.message ? e.message : String(e) };
    }
    const failed = r && r.ok === false;
    log.push('[' + (i + 1) + '/' + steps.length + '] ' + s.tool + (failed ? ' ✗ ' + String(r.result || '').slice(0, 120) : ' ✓'));
    // 宏中途可能开新标签页：把 ctx 就地切过去，后续步骤才在正确的页上执行。
    if (r && Number.isInteger(Number(r.targetTabId))) {
      ctx.tabId = Number(r.targetTabId);
      if (r.targetTab) {
        ctx.pageUrl = r.targetTab.url || ctx.pageUrl;
        ctx.pageTitle = r.targetTab.title || ctx.pageTitle;
      }
    }
    if (failed) {
      return {
        ok: false,
        result: '宏「' + name + '」在第 ' + (i + 1) + ' 步失败，已停止：\n' + log.join('\n'),
        ...(r && r.needsUserAction === true
          ? { needsUserAction: true, sensitiveAction: r.sensitiveAction }
          : {}),
      };
    }
  }
  await deps.bumpMacroHits(deps.pageUrl, name).catch(() => {});
  return { ok: true, result: '已回放宏「' + name + '」（' + steps.length + ' 步）：\n' + log.join('\n') };
}

/** 合法的 op 取值。显式列出，便于报错时给出可用选项。 */
export const MACRO_OPS = ['save', 'list', 'run'];

/** 统一入口：macro({ op, name?, description? })。op 必填。 */
export async function macroTool(deps, args) {
  const op = String((args && args.op) || '').trim();
  if (!op) return { ok: false, result: 'macro 需要 op 参数，取值：' + MACRO_OPS.join(' / ') + '。' };
  if (op === 'save') return await macroSave(deps, args);
  if (op === 'list') return await macroList(deps);
  if (op === 'run') return await macroRun(deps, args);
  return { ok: false, result: '未知的 op「' + op + '」，取值：' + MACRO_OPS.join(' / ') + '。' };
}
