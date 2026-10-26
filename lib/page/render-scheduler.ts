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
 * 兜底延迟：排了帧之后，若 `requestFrame` 迟迟不回调，也要在这么久之后跑一次。
 *
 * 为什么必须有它（用户实测缺陷"对话进行中切到其它 tab，流式也没有到最底下"）：
 * 浏览器在**隐藏标签页**里会暂停 `requestAnimationFrame` —— 排出去的帧回调根本不执行，
 * 而本调度器"已经排了帧就不再排"（`handle !== null` 时直接返回），于是**整个隐藏期间
 * 一次渲染与置底都不会发生**；回到标签页时视图停在离开前那一屏。
 * `setTimeout` 在隐藏标签页里只是被降频、**不会**被暂停，所以它能保证"总有下一次渲染"。
 * 取 32ms（两帧）是为了在正常可见标签页里**永远输给 rAF**：兜底只在 rAF 真的不来时生效，
 * 不会把合并粒度从"一帧"变成"32ms"。
 */
const FRAME_FALLBACK_MS = 32;

/** 帧句柄：rAF 是 number、setTimeout 在 node 里是 Timeout，这里不区分。 */
type FrameHandle = number | ReturnType<typeof setTimeout>;

/** 注入点，全部可省：省了就用浏览器全局（并按需回退到定时器）。 */
export interface FrameSchedulerOptions {
  /** 安排下一次绘制，默认 requestAnimationFrame（不可用时回退 setTimeout 16ms） */
  requestFrame?: (cb: () => void) => FrameHandle;
  /** 取消已排的帧 */
  cancelFrame?: (handle: FrameHandle) => void;
  /** 兜底定时器（失焦/隐藏标签页里 rAF 会被暂停，见 FRAME_FALLBACK_MS） */
  setFallbackTimer?: (cb: () => void, ms: number) => FrameHandle | null;
  /** 取消兜底定时器 */
  clearFallbackTimer?: (handle: FrameHandle) => void;
}

export function createFrameScheduler(options: FrameSchedulerOptions = {}) {
  const requestFrame =
    options.requestFrame ||
    (typeof requestAnimationFrame === 'function'
      ? (cb: () => void) => requestAnimationFrame(cb)
      : (cb: () => void) => setTimeout(cb, 16));
  const cancelFrame =
    options.cancelFrame ||
    (typeof cancelAnimationFrame === 'function'
      ? (h: FrameHandle) => cancelAnimationFrame(Number(h))
      : (h: FrameHandle) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const setFallbackTimer =
    options.setFallbackTimer ||
    ((cb: () => void, ms: number) => (typeof setTimeout === 'function' ? setTimeout(cb, ms) : null));
  const clearFallbackTimer =
    options.clearFallbackTimer ||
    ((h: FrameHandle) => {
      if (typeof clearTimeout === 'function') clearTimeout(h as ReturnType<typeof setTimeout>);
    });

  let handle: FrameHandle | null = null;
  let fallbackHandle: FrameHandle | null = null;
  let pending = new Map<string, () => void>(); // key -> 最新回调；Map 保留首次插入顺序

  /** 清掉两个"本次绘制已被安排"的凭据（帧 + 兜底定时器）。 */
  const clearScheduled = () => {
    if (handle !== null) {
      try {
        cancelFrame(handle);
      } catch (e) {}
      handle = null;
    }
    if (fallbackHandle !== null) {
      try {
        clearFallbackTimer(fallbackHandle);
      } catch (e) {}
      fallbackHandle = null;
    }
  };

  const runPending = () => {
    clearScheduled();
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
    schedule(key: string, fn: () => void) {
      if (typeof fn !== 'function') return;
      pending.set(String(key), fn);
      if (handle === null) handle = requestFrame(runPending);
      // 兜底与帧同时安排：正常可见时 rAF 先到（32ms 内必到），兜底被清掉、不重复渲染；
      // 隐藏标签页里 rAF 被暂停，则由兜底把这一批画出去（见 FRAME_FALLBACK_MS 的说明）。
      if (fallbackHandle === null) fallbackHandle = setFallbackTimer(runPending, FRAME_FALLBACK_MS);
    },
    /** 立即执行待处理的绘制，并取消已排的帧。用于收尾：保证最后一次渲染不会被后续帧覆盖。 */
    flush() {
      clearScheduled();
      runPending();
    },
    /** 丢弃待处理的绘制（不执行）。 */
    cancel() {
      clearScheduled();
      pending = new Map();
    },
    /** 待处理的目标数量，供测试与断言使用。 */
    get pendingCount() {
      return pending.size;
    },
  };
}
