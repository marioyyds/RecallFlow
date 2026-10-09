// 统一工具守卫：把「重复调用 / 连续失败 / 无进展」三类判定收敛到一处。
//
// ## 只提醒，不否决
//
// 这里的 `level` **只有 ok 与 reflect 两种**：命中任何阈值都只往模型上下文里注入一条建议，
// 调用照常执行。守卫绝不摘除工具、绝不终止任务。
//
// 为什么改成这样（原先命中即 disable / stop）：摘除工具是在**替模型做决定**。
// 只有模型知道这次重复是空转还是幂等轮询（等状态变化、确认渲染完成）。实测代价：
// 一次冒烟测试里 `outline_element` 因「连续失败熔断」被停用，agent 只能在报告里解释
// 「不是页面问题，是策略所致」—— 一个本来能用的工具被拿走了。
//
// 这套做法取自 DSH 的 repeat-tool-reminder，它的四条设计承诺：
//   1. 仅建议，不否决 —— guard 用模型上下文丰富 post-execute 决策，从不阻止或改写调用；
//   2. 在 post-execute 中计数 —— 被拒绝的调用同样经过这里，因为「反复尝试被拒绝的调用」
//      恰恰是最需要打破的循环；
//   3. 精确匹配规范化 —— 深度键排序 + 序列化即完整的同一性判定；**不做模糊匹配**
//      （近似变体绕过检测是可接受的已知限制，没有需求证据就不引入模糊匹配）；
//   4. 阈值分级递进 —— 首次简短、后续详细并列出重复的参数，**超过最高阈值后不再打扰**。
//
// 提醒的注入必须是**纯追加**（见 agent.js：所有反思都在工具结果之后统一追加），
// 否则会改动请求前缀、让服务端缓存失效。

// 稳定的参数序列化：键顺序无关，便于把「同一逻辑调用」识别为重复。
export function canonicalize(value) {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalize(value[key])).join(',') + '}';
}

// 重复调用的提醒阈值（与 DSH 默认值一致）。只在**精确达到**时提醒，超过最高值不再打扰。
export const REPEAT_THRESHOLDS = Object.freeze([3, 5, 8]);
// 连续失败 / 无进展的提醒阈值。同样是精确跨越才提醒。
export const FAIL_THRESHOLDS = Object.freeze([2, 3, 5]);
export const NO_PROGRESS_THRESHOLDS = Object.freeze([3, 5, 8]);
// 详细提醒里最多展示多少字符的重复参数（对齐 DSH 的 argumentsPreviewChars）。
export const ARGS_PREVIEW_CHARS = 500;
// 默认不跟踪的工具：记录类工具，穿插其间不能掩盖循环（DSH 默认排除 todo_write）。
export const DEFAULT_EXCLUDED_TOOLS = Object.freeze(['update_plan']);

/** 精确跨越阈值：只在 count 恰好等于某个阈值时提醒。 */
function crosses(count, thresholds) {
  return thresholds.indexOf(count) !== -1;
}

function clipArgs(args) {
  let text;
  try {
    text = JSON.stringify(args || {});
  } catch (e) {
    text = String(args);
  }
  text = String(text);
  if (text.length <= ARGS_PREVIEW_CHARS) return text;
  return text.slice(0, ARGS_PREVIEW_CHARS) + '… (+' + (text.length - ARGS_PREVIEW_CHARS) + ' more chars)';
}

export function createToolGuard(budget = {}) {
  const repeatThresholds = Array.isArray(budget.repeatThresholds) && budget.repeatThresholds.length
    ? budget.repeatThresholds.map((n) => Math.max(2, Number(n) || 0)).filter(Boolean).sort((a, b) => a - b)
    : REPEAT_THRESHOLDS.slice();
  const failThresholds = Array.isArray(budget.failThresholds) && budget.failThresholds.length
    ? budget.failThresholds.map((n) => Math.max(1, Number(n) || 0)).filter(Boolean).sort((a, b) => a - b)
    : FAIL_THRESHOLDS.slice();
  const noProgressThresholds = Array.isArray(budget.noProgressThresholds) && budget.noProgressThresholds.length
    ? budget.noProgressThresholds.map((n) => Math.max(2, Number(n) || 0)).filter(Boolean).sort((a, b) => a - b)
    : NO_PROGRESS_THRESHOLDS.slice();
  const excluded = new Set(
    (Array.isArray(budget.excludeTools) && budget.excludeTools.length ? budget.excludeTools : DEFAULT_EXCLUDED_TOOLS).map(String)
  );

  // 当前重复链：同一条 (工具, 规范化参数) 连续出现才计数；换成另一条被跟踪的调用则重置为 1。
  let chain = { key: '', count: 0, name: '' };
  let failStreak = new Map(); // 工具名 -> 连续失败次数
  let noProgressStreak = 0; // 跨工具的无进展连击

  function observe(input) {
    // 注意不能写成 `input = {}` 默认参数：显式传 null 时默认值不生效，读属性会抛。
    const o = input || {};
    const name = String(o.name || '');
    const fingerprint = name + ':' + canonicalize(o.args || {});
    const result = o.result;
    const verification = result && result.verification;
    const rejected = o.rejected === true;
    // 失败：执行返回 ok=false，或参数校验未通过。被用户拒绝不算工具的错。
    const failed = (result && result.ok === false) || o.validationFailed === true;
    const readOnly = o.readOnly === true;
    const mutation = !readOnly;
    const negativeVerification = !!(verification && (verification.executed === false || verification.verified === false));
    const noProgress = failed || rejected || (mutation && negativeVerification);
    const succeeded = !failed && !rejected;

    // 可观察进展：清空无进展连击与失败连击。
    if (o.progress === true) {
      noProgressStreak = 0;
      // 有进展时也断开重复链：链的语义是「连续重复」，不是「历史累计」。
      chain = { key: '', count: 0, name: '' };
    }

    if (failed) failStreak.set(name, (failStreak.get(name) || 0) + 1);
    else if (succeeded) failStreak.delete(name);

    if (failed || rejected) noProgressStreak += 1;
    else noProgressStreak = 0;

    const currentFail = failStreak.get(name) || 0;

    // 未被跟踪的工具对链**透明**：既不递增也不重置，
    // 因此 `grep X → update_plan → grep X` 仍算连续两次（穿插的记录类工具不能掩盖循环）。
    const tracked = !excluded.has(name);
    let repeated = 0;
    if (tracked) {
      if (chain.key === fingerprint) chain.count += 1;
      else chain = { key: fingerprint, count: 1, name };
      repeated = chain.count;
    }

    const messages = [];
    let reason = '';

    // ① 重复调用（DSH 的核心机制）：分级、精确跨越、超上限不再提醒。
    if (tracked && crosses(repeated, repeatThresholds)) {
      const first = repeated === repeatThresholds[0];
      reason = 'maxSameToolCalls';
      messages.push(
        first
          ? '你正在用**完全相同的参数**重复调用同一个工具。再次调用前请先仔细分析上一次的返回：' +
            '如果任务还没完成，换一种做法或换一组参数，而不是原样再调一次。'
          : '检测到重复的工具调用：\n' +
            '- 工具：' + name + '\n' +
            '- 连续次数：' + repeated + '\n' +
            '- 参数：' + clipArgs(o.args) + '\n' +
            '这些重复调用没有产生新的进展。不要再用**这组完全相同的参数**调用它：' +
            '请查看最近一次返回，改换动作、改换参数，或者在证据已经足够时直接结束任务。'
      );
    }

    // ② 连续失败：同样只建议。
    if (crosses(currentFail, failThresholds)) {
      reason = reason || 'toolFailStreak';
      messages.push('工具「' + name + '」已连续失败 ' + currentFail + ' 次。请先弄清失败原因（看错误信息与页面真实状态），换一种定位方式或换用别的工具，不要原样重试。');
    }

    // ③ 跨工具的无进展连击：仍不停止任务，只提醒。
    if (crosses(noProgressStreak, noProgressThresholds)) {
      reason = reason || 'noProgress';
      messages.push(
        '最近 ' + noProgressStreak + ' 次动作都没有产生可观察的进展。请停下来重新读取页面确认当前状态，' +
          '或换一条完全不同的思路；若确实无法推进，就把卡点如实说清楚并结束任务。'
      );
    }

    const level = messages.length ? 'reflect' : 'ok';
    return {
      level,
      name,
      fingerprint,
      readOnly,
      repeated,
      failStreak: currentFail,
      noProgressStreak,
      reason,
      message: messages.join('\n\n'),
    };
  }

  return {
    observe,
    reset() {
      chain = { key: '', count: 0, name: '' };
      noProgressStreak = 0;
      failStreak = new Map();
    },
    snapshot() {
      return {
        chain: Object.assign({}, chain),
        noProgressStreak,
        failStreak: Array.from(failStreak.entries()),
      };
    },
    restore(state) {
      if (!state || typeof state !== 'object') return;
      chain = state.chain && typeof state.chain === 'object'
        ? { key: String(state.chain.key || ''), count: Number(state.chain.count) || 0, name: String(state.chain.name || '') }
        : { key: '', count: 0, name: '' };
      noProgressStreak = Number(state.noProgressStreak) || 0;
      failStreak = new Map(Array.isArray(state.failStreak) ? state.failStreak : []);
    },
    getState() {
      return this.snapshot();
    },
  };
}
