// 跨域框架的目标与 ref 解析（从 tools.js 抽出的第三个模块）。
//
// 抽取动机：这组函数决定"一个动作该投递到哪个框架、投递时参数要改成什么"，
// 而这是**跨域 iframe 操作能否成立的核心**（跨源 iframe 的 DOM 无法从顶层读取，
// 只能把消息投到对应框架、由该框架自己的内容脚本解析）。
// 它们此前混在 tools.js 的 chrome.* 调用之间，只能通过真实浏览器间接验证；
// 抽成纯模块后可以直接把 ref 前缀、显式 frameId 优先级、参数改写这些边界钉住。
//
// ref 约定：跨域 iframe 的 ref 形如 `f<frameId>:<localRef>`（由 get_page_snapshot 的
// includeFrames 产出）；顶层框架的 ref 不带前缀，frameId 视为 0。

/** 拆出 ref 的框架前缀。无前缀时 frameId 为 null（表示"未在 ref 中指定"）。 */
export function parseRef(ref: unknown) {
  const m = String(ref || '').match(/^f(\d+):(.*)$/);
  if (m) return { frameId: Number(m[1]), ref: m[2] };
  return { frameId: null, ref: String(ref || '') };
}

/**
 * 从工具参数里求出目标框架 id。
 *
 * 优先级：**显式 frameId 参数 > ref 前缀**。显式参数优先是有意的 ——
 * 模型有时会从帧列表里拿到 frameId 并直接传参，此时 ref 可能仍是顶层形态，
 * 若让 ref 前缀覆盖显式参数，动作会投递到错误的框架。
 */
export function frameIdFromArgs(args: Record<string, unknown>) {
  if (!args) return null;
  if (args.frameId !== undefined && args.frameId !== null && args.frameId !== '' && Number.isInteger(Number(args.frameId)) && Number(args.frameId) >= 0) {
    return Number(args.frameId);
  }
  return parseRef(args.ref).frameId;
}

/**
 * 去掉 ref 的 frame 前缀，得到发给**目标框架**内容脚本的本地参数。
 *
 * 同时删掉 frameId：那个字段只对后台有意义，内容脚本在自己的框架里
 * 不该再看到一个 frameId（否则它可能把动作再转发一次，造成重复执行）。
 */
export function localTargetArgs(args: Record<string, unknown>) {
  const out = Object.assign({}, args || {});
  const p = parseRef(out.ref);
  if (p.frameId != null) out.ref = p.ref;
  delete out.frameId;
  return out;
}

/**
 * 把目标列表按所属框架分组，并给出每批要发给该框架的**本地**参数。
 *
 * 为什么必须分组：跨源 iframe 的 DOM 无法从顶层读取（queryAllInFrames 会跳过），
 * 只能把消息投递到对应框架、由该框架自己的内容脚本解析。
 */
export function planFrameBatches(targets: unknown) {
  const list: Array<Record<string, unknown>> = Array.isArray(targets) ? targets : [];
  const groups = new Map<number, Array<{ at: number; target: Record<string, unknown> }>>();
  list.forEach((t, i) => {
    const frameId = frameIdFromArgs(t) || 0;
    const bucket = groups.get(frameId);
    if (bucket) bucket.push({ at: i, target: localTargetArgs(t) });
    else groups.set(frameId, [{ at: i, target: localTargetArgs(t) }]);
  });
  return Array.from(groups.entries()).map(([frameId, items]) => ({ frameId, items }));
}
