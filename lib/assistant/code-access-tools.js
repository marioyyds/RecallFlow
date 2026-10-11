// 页面内代码与结构访问族（run_javascript / get_ax_snapshot）—— C-1 拆出的第 11 族。
//
// 为什么这两者算一族：它们是**访问页面"活状态"的两条深路径** ——
// 一个执行 JS 直接读写页面自身变量，一个读可访问性树拿到 DOM 之外的可交互节点
//（canvas / 虚拟列表等无普通 DOM 的场景）。两者都优先用 CDP。
//
// **搬运原则：不重写行为。** 实现从 tools.js 原样搬来，闭包依赖改为显式注入。
//
// ⚠ 三条**有意保留**的语义（都踩过坑，不要"顺手简化"）：
//   1. `run_javascript` 默认走**内容脚本受限沙箱**（无 `chrome.*`），只有显式
//      `engine:'page'` 才走 CDP 页面主世界 —— 这是权限最小化，不是性能优化。
//      ⚠ **但实测这条默认路径在任何页面上都跑不起来**：沙箱用 `new Function`，
//      而 MV3 扩展自身的 CSP 不允许 eval（与页面 CSP 无关，在没有 CSP 的页面上同样被拒）。
//      所以实际行为是：**总是**落到下面的 CSP 自动重试 → 需要 CDP。
//      保留沙箱路径的价值在于"权限最小"的意图与将来的兼容性，但**不要**在文档里
//      把它写成"DOM 够用时就能用" —— 那会让人以为关掉 CDP 还能做简单读取 ✗
//   2. **CSP 自动重试**：沙箱用 `new Function` 实现，被拒时自动改用页面主世界重试：
//      同一段代码、同一次审批，模型不必多花一轮，**也不会再弹一次审批**。
//   3. `get_ax_snapshot` **只挑交互角色**并尽量补坐标；坐标取不到就照常返回该节点
//      （不要因为拿不到坐标就把它丢掉）。
//
// `evaluateInPageWorld` 见 ./page-world.js（那里有它自己的说明）。
// 失败翻译器是纯函数，直接 import（不走 deps 注入，避免打断既有调用方）。
import { describeContentScriptUnreachable } from '../shared/utils.js';

/** run_javascript：先沙箱、被 CSP 拒则自动改用页面主世界。 */
export async function runJavascript(deps, args) {
  const ctx = deps.ctx;
  // engine='page'：用 CDP Runtime.evaluate 在页面主世界执行（可访问页面自身 JS 状态，
  // 且不受页面 CSP 限制）；默认走内容脚本受限沙箱（无 chrome.*）。
  if (args.engine === 'page' || args.pageWorld === true) {
    return await deps.evaluateInPageWorld(ctx, args);
  }
  try {
    const r = await deps.executeContentAction(ctx.tabId, 'run_javascript', { type: 'kbRunJavaScript', params: args }, { delayMs: 80 });
    if (r && r.ok === false) {
      // 沙箱用 `new Function`，而 **MV3 扩展自身的 CSP 不允许 eval** —— 与页面无关
      //（实测在没有任何 CSP 的页面上同样被拒，原始错误里那条 directive 是扩展的）。
      // 所以这条重试实际**总会发生**：这里自动改用页面主世界，同一段代码、同一次审批，
      // 模型不必多花一轮，也不会再弹一次审批。
      const msg = String((r && (r.error || r.result)) || '');
      if (deps.isCspEvalBlockError(msg)) {
        if (!deps.cdpAllowed(ctx)) {
          return {
            ok: false,
            result:
              // ⚠ 归因必须准确：**这不是页面造成的**。
              // 沙箱用 `new Function`，而 MV3 扩展自身的 CSP 不允许 eval ——
              // 实测在**完全没有 CSP** 的页面上同样被拒（原始错误里那条 directive 是扩展的，
              // 不是页面的）。此前文案写成"页面未放行 unsafe-eval"，会把用户与模型引向
              // "换个页面试试"这个错误方向 ✗
              'run_javascript 需要页面主世界执行（CDP），当前未开启。' +
              '原因：默认的受限沙箱用 `new Function` 实现，而 **MV3 扩展自身的 CSP 不允许 eval** —— ' +
              '这与页面无关（在没有任何 CSP 的页面上同样被拒）。' +
              '请在设置中开启「浏览器级输入层（CDP）」后重试。原始错误：' +
              msg.slice(0, 200),
          };
        }
        const retry = await deps.evaluateInPageWorld(ctx, args);
        if (retry && retry.ok) {
          return Object.assign({}, retry, {
            result: '（沙箱需要 eval，而 MV3 扩展自身的 CSP 不允许 —— 已自动改用页面主世界执行）\n' + (retry.result || ''),
          });
        }
        return {
          ok: false,
          result: '沙箱需要 eval（MV3 扩展自身的 CSP 不允许，与页面无关）；改用页面主世界同样失败：' + ((retry && retry.result) || '未知错误'),
        };
      }
      return r;
    }
    if (r && r.verification) {
      // JS 可能只读取不改页面，快照验证不一定有变化，此时以返回结果为准。
      r.verification.reason = 'JS 已执行，返回结果见上';
    }
    return r;
  } catch (e) {
    // `ok:false` 早就在这里（这一处是对的），但文案是原始错误 —— 对模型毫无指导。
    // 实测（B 站转写）：这类站点上模型连续 8 次收到 "Could not establish connection.
    // Receiving end does not exist."，最后自己摸索出"改用主世界 JS"。现在翻成可操作的文案。
    return { ok: false, result: describeContentScriptUnreachable(e.message, '执行 JS 失败：') };
  }
}

/** 可访问性树里值得暴露给模型的角色（其余是布局/文本节点，塞进来只会占 token）。 */
export const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox',
  'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider',
  'spinbutton', 'treeitem', 'gridcell',
]);

/** get_ax_snapshot：读可访问性树里的可交互节点（含 role/名称/坐标）。 */
export async function getAxSnapshot(deps, args) {
  const ctx = deps.ctx;
  if (!deps.cdpAllowed(ctx)) return { ok: false, result: '可访问性树快照需要 CDP（请在设置中开启）。' };
  try {
    const nodes = await deps.cdp.getFullAxTree(ctx.tabId);
    const limit = Math.min(120, Math.max(1, Number(args.limit) || 60));
    const picked = [];
    for (const n of nodes) {
      if (!n || n.ignored) continue;
      const role = n.role && n.role.value;
      if (!role || !INTERACTIVE_ROLES.has(role)) continue;
      const name = String((n.name && n.name.value) || '').slice(0, 120);
      picked.push({ role, name, locator: { role, name }, backendDOMNodeId: n.backendDOMNodeId });
      if (picked.length >= limit) break;
    }
    const withBox = [];
    for (const p of picked) {
      if (!p.backendDOMNodeId) { withBox.push(p); continue; }
      try {
        const box = await deps.cdp.getBoxModel(ctx.tabId, p.backendDOMNodeId);
        const q = box && box.content;
        if (q && q.length >= 8) {
          const cx = Math.round((q[0] + q[2] + q[4] + q[6]) / 4);
          const cy = Math.round((q[1] + q[3] + q[5] + q[7]) / 4);
          withBox.push(Object.assign({}, p, { x: cx, y: cy }));
        } else {
          withBox.push(p); // 坐标取不到也照常返回该节点
        }
      } catch (e) {
        withBox.push(p);
      }
    }
    const lines = withBox.map((p, i) => '[' + (i + 1) + '] ' + p.role + '「' + p.name + '」' + (p.x != null ? ' 坐标(' + p.x + ',' + p.y + ')' : ''));
    return {
      ok: true,
      ax: withBox,
      result:
        '可访问性树（交互节点 ' + withBox.length + ' 个，含 role/名称/坐标）：\n' + (lines.join('\n') || '（无）') +
        '\n用法：优先用 role+name 定位（如 click_element({role:"button",name:"登录"})），比坐标更稳；canvas/虚拟列表等无 DOM 场景再用坐标 click_at。',
    };
  } catch (e) {
    return { ok: false, result: '读取可访问性树失败：' + deps.summarizeCdpError(e) };
  }
}

/** 该族处理哪些工具名。 */
export const CODE_ACCESS_TOOLS = new Set(['run_javascript', 'get_ax_snapshot']);

/** 统一入口。返回 null 表示"不属于本族"。 */
export async function handleCodeAccessTool(name, args, deps) {
  if (name === 'run_javascript') return await runJavascript(deps, args);
  if (name === 'get_ax_snapshot') return await getAxSnapshot(deps, args);
  return null;
}
