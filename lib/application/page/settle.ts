// 「等待页面稳定」原语 —— 动作后不靠固定 sleep，而是等真实静默。
//
// 为什么需要它：原实现是 `nextPaint() { return new Promise((r) => setTimeout(r, 50)); }`。
// 50ms 对同步渲染够用，但对 SPA（React/Vue 异步渲染、表单受控组件回写、字体/布局抖动、
// 请求回来后再渲染）远远不够。于是「动作后立刻读状态」会拿到旧值：
//   - 工具把成功报成失败（值还没写进去）
//   - 或把失败报成成功（旧值恰好满足断言）
// 对一个**以「验证改动是否生效」为卖点**的调试工具来说，这是地基问题。
//
// 设计：rAF 心跳 + MutationObserver 静默窗口 + 硬上限。
//   - 连续 quietMs 内没有 DOM 变更 → 认为稳定，提前结束
//   - 到 maxMs 仍未静默 → 也结束（绝不能挂死）
// 取「最短满足其一」，因此既比固定 sleep 更快（简单页面几十 ms 就返回），
// 又比它更可靠（复杂页面会等到真正静默）。
//
// 本模块刻意不碰 DOM 具体细节，便于在 node 里用桩直接测（见 tests/page-settle.test.mjs）。

export const SETTLE_DEFAULTS = Object.freeze({
  /** 静默窗口：连续这么久没有 DOM 变更就认为稳定 */
  quietMs: 180,
  /** 硬上限：无论如何不超过这个时间，避免挂死 */
  maxMs: 1200,
  /** rAF 不可用时的退避步长 */
  fallbackStepMs: 50,
});

/**
 * 归一化参数，非法值一律退回默认（0/负数/非数字不表示"不等待"）。
 * @returns {{quietMs:number,maxMs:number,fallbackStepMs:number}}
 */
export interface SettleOptions {
  /** 静默窗口（ms），非法值退回默认 */
  quietMs?: number;
  /** 硬上限（ms） */
  maxMs?: number;
  /** rAF 不可用时的退避步长（ms） */
  fallbackStepMs?: number;
}

/** normalizeSettleOptions 的输出：三个字段都已被合法化。 */
export interface NormalizedSettleOptions {
  quietMs: number;
  maxMs: number;
  fallbackStepMs: number;
}

/** 等待原语的结果。 */
export interface SettleResult {
  settled: boolean;
  reason: string;
  elapsedMs: number;
  mutations: number;
}

/**
 * 运行环境注入点（便于测试用桩替换浏览器全局）。
 * 每个字段都可省：省了就用对应的浏览器全局，浏览器不可用时退化到「退避式等待」。
 */
export interface SettleEnv {
  doc?: Document | null;
  raf?: ((cb: () => void) => number) | null;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export function normalizeSettleOptions(opts: SettleOptions = {}): NormalizedSettleOptions {
  const pick = (v: number | undefined, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  const quietMs = pick(opts.quietMs, SETTLE_DEFAULTS.quietMs);
  // maxMs 至少要覆盖一个静默窗口，否则永远等不到静默就已经超时，
  // 表现为「这个原语看起来在等、其实总是走到上限」，比固定 sleep 更难排查。
  const maxMs = Math.max(pick(opts.maxMs, SETTLE_DEFAULTS.maxMs), quietMs);
  return { quietMs, maxMs, fallbackStepMs: pick(opts.fallbackStepMs, SETTLE_DEFAULTS.fallbackStepMs) };
}

/**
 * 等待页面稳定。
 *
 * @param {Object} [env] 运行环境（便于测试注入桩）
 * @param {Object} [env.doc] 具备 MutationObserver 的 document（缺省用全局 document）
 * @param {Function} [env.raf] requestAnimationFrame 等价物
 * @param {Function} [env.now] 取当前时间
 * @param {Function} [env.setTimeoutFn] / [env.clearTimeoutFn]
 * @param {Object} [options] 见 normalizeSettleOptions
 * @returns {Promise<{settled:boolean,reason:string,elapsedMs:number,mutations:number}>}
 */
export function waitForSettle(env: SettleEnv = {}, options: SettleOptions = {}): Promise<SettleResult> {
  const { quietMs, maxMs, fallbackStepMs } = normalizeSettleOptions(options);
  const doc = env.doc || (typeof document !== 'undefined' ? document : null);
  const raf = env.raf || (typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame : null);
  const now = env.now || (() => Date.now());
  const setTimeoutFn = env.setTimeoutFn || setTimeout;
  const clearTimeoutFn = env.clearTimeoutFn || clearTimeout;

  const start = now();
  let mutations = 0;
  let observer: MutationObserver | null = null;
  let rafId: number | null = null;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let maxTimer: ReturnType<typeof setTimeout> | null = null;
  let done = false;
  let resolveFn: ((value: SettleResult) => void) | null = null;

  const finish = (reason: string) => {
    if (done) return;
    done = true;
    if (observer) {
      try { observer.disconnect(); } catch (e) {}
    }
    if (rafId !== null && typeof cancelAnimationFrame === 'function') {
      try { cancelAnimationFrame(rafId); } catch (e) {}
    }
    if (quietTimer) clearTimeoutFn(quietTimer);
    if (maxTimer) clearTimeoutFn(maxTimer);
    if (resolveFn) resolveFn({ settled: reason !== 'timeout', reason, elapsedMs: now() - start, mutations });
  };

  return new Promise((resolve) => {
    resolveFn = resolve;

    // 无 DOM 可观察（如 node 测试或极端环境）→ 退避式等待，保证语义不退化成"立刻返回"。
    if (!doc || typeof doc !== 'object' || typeof MutationObserver === 'undefined') {
      const timer = setTimeoutFn(() => finish('no-observer'), doc ? quietMs : fallbackStepMs);
      // 该 timer 由 finish 之外的路径清理：挂到 quietTimer 上统一处理
      quietTimer = timer;
      return;
    }

    try {
      observer = new MutationObserver(() => {
        mutations++;
        // 每次变更都重置静默窗口：只要还在变，就继续等（直到 maxMs）。
        if (quietTimer) clearTimeoutFn(quietTimer);
        quietTimer = setTimeoutFn(() => finish('quiet'), quietMs);
      });
      observer.observe(doc.documentElement || doc, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
    } catch (e) {
      observer = null;
    }

    // 起手就安排一次静默判定：没有任何变更时也要能结束（否则只能等 maxMs）。
    quietTimer = setTimeoutFn(() => finish('quiet'), quietMs);
    maxTimer = setTimeoutFn(() => finish('timeout'), maxMs);

    // rAF 心跳：让出渲染帧，避免在布局未完成时读值。
    // 它不直接结束等待，只用于推进时间/触发浏览器完成一次绘制。
    if (typeof raf === 'function') {
      const tick = () => {
        if (done) return;
        rafId = raf(tick);
      };
      rafId = raf(tick);
    }
  });
}
