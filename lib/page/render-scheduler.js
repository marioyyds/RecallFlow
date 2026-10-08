// 帧级渲染合并器：把同一帧内多次「重绘」请求折叠成一次。
//
// 动机是一个实测到的超线性成本：模型的流式输出是**逐 token** 到达的
// （agent.js 每收到一个 SSE delta 就发一条 chunk），而面板每收到一条 chunk 都会
//   ① 对**累积全文**重跑一遍 markdown 解析（第 N 个 token 要重解析前 N 个）
//   ② innerHTML 全量重建 DOM
//   ③ fitPanelHeight()：先写 style 再读 scrollHeight —— 强制同步布局
//   ④ panelBody.scrollTop = scrollHeight —— 又一次强制布局
// 实测解析这一项本身就是超线性的（1000→4000 token 时累计耗时 ×12），
// 而 DOM 重建与两次强制布局比解析更贵。长回答因此会明显掉帧。
//
// 这里只做一件事：同一帧内的多次 schedule 只在实际绘制前执行一次，且每个 key
// 只保留**最后一次**的回调（流式渲染要的正是「用最新文本重绘一遍」）。
//
// 抽成独立模块是因为它是整条路径上唯一不依赖 DOM、可被穷举测试的部分 ——
// 而「合并」写错的代价是丢渲染或无限套娃，比多渲染几次严重得多。
//
// 注入 requestFrame / cancelFrame 而不是直接用全局 rAF：测试里用假帧队列可确定性地
// 驱动「同一帧」「跨帧」「flush 期间再次 schedule」这些时序分支。

/**
 * @param {object} [options]
 * @param {(cb:Function)=>any} [options.requestFrame] 默认 rAF，回退到 setTimeout
 * @param {(handle:any)=>void} [options.cancelFrame]
 */
export function createFrameScheduler(options = {}) {
  const requestFrame =
    options.requestFrame ||
    (typeof requestAnimationFrame === 'function'
      ? (cb) => requestAnimationFrame(cb)
      : (cb) => setTimeout(cb, 16));
  const cancelFrame =
    options.cancelFrame ||
    (typeof cancelAnimationFrame === 'function'
      ? (h) => cancelAnimationFrame(h)
      : (h) => clearTimeout(h));

  let handle = null;
  let pending = new Map(); // key -> 最新回调；Map 保留首次插入顺序

  const runPending = () => {
    handle = null;
    if (!pending.size) return;
    // 先整体取出再清空：回调内部再次 schedule 的应当落到**下一帧**，
    // 否则一个「渲染后又要重排」的回调会在本帧里自己把自己再排一次，形成套娃。
    const entries = Array.from(pending.values());
    pending = new Map();
    for (const fn of entries) {
      // 单个回调抛错不能拖垮同帧的其余渲染（尤其布局那一步）
      try {
        fn();
      } catch (e) {}
    }
  };

  return {
    /**
     * 排入一次绘制。同一 key 在一帧内被多次排入时，只有最后一次会被执行。
     * @param {string} key 逻辑绘制目标（如 'answer' / 'layout'），决定去重粒度
     * @param {Function} fn
     */
    schedule(key, fn) {
      if (typeof fn !== 'function') return;
      pending.set(String(key), fn);
      if (handle === null) handle = requestFrame(runPending);
    },
    /** 立即执行待处理的绘制，并取消已排的帧。用于收尾：保证最后一次渲染不会被后续帧覆盖。 */
    flush() {
      if (handle !== null) {
        try {
          cancelFrame(handle);
        } catch (e) {}
        handle = null;
      }
      runPending();
    },
    /** 丢弃待处理的绘制（不执行）。 */
    cancel() {
      if (handle !== null) {
        try {
          cancelFrame(handle);
        } catch (e) {}
        handle = null;
      }
      pending = new Map();
    },
    /** 待处理的目标数量，供测试与断言使用。 */
    get pendingCount() {
      return pending.size;
    },
  };
}
