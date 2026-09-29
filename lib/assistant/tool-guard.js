// 统一工具守卫：把「重复调用 / 连续失败 / 无进展」三类判定收敛到一处，
// 输出分级动作（ok / reflect / disable / stop）。
// 默认软着陆：命中重复或连续失败时优先「摘除冒犯工具 + 反思继续」，而不是终止整个任务；
// 只有在跨工具持续无进展时才 stop（全局预算触顶仍由 agent 主循环单独兜底）。

// 稳定的参数序列化：键顺序无关，便于把「同一逻辑调用」识别为重复。
export function canonicalize(value) {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalize(value[key])).join(',') + '}';
}

export function createToolGuard(budget = {}) {
  const windowSize = Math.max(3, Number(budget.stuckWindow) || 8);
  const reflectThreshold = Math.max(2, Number(budget.stuckWarnThreshold) || 3);
  const stopThreshold = Math.max(reflectThreshold + 1, Number(budget.stuckStopThreshold) || 5);
  const sameToolLimit = Math.max(1, Number(budget.maxSameToolCalls) || 4);
  const readOnlySameToolLimit = Math.max(sameToolLimit, Number(budget.readOnlySameToolCalls) || 8);
  const failLimit = Math.max(1, Number(budget.toolFailStreak) || 2);
  const readOnlyFailLimit = Math.max(failLimit, Number(budget.readOnlyFailStreak) || 3);

  let history = []; // 最近的调用指纹窗口：{ fingerprint, at }
  let noProgressStreak = 0;
  let failStreak = new Map(); // 工具名 -> 连续失败次数

  function observe(input = {}) {
    const name = String(input.name || '');
    const readOnly = input.readOnly === true;
    const fingerprint = name + ':' + canonicalize(input.args || {});
    const result = input.result;
    const verification = result && result.verification;
    const rejected = input.rejected === true;
    // 失败：执行返回 ok=false，或参数校验未通过。
    const failed = (result && result.ok === false) || input.validationFailed === true;
    // 无进展：失败、被用户拒绝、或变更类工具的验证判定为「未执行/未达成」。
    const mutation = !readOnly;
    const negativeVerification = !!(verification && (verification.executed === false || verification.verified === false));
    const noProgress = failed || rejected || (mutation && negativeVerification);
    const succeeded = !failed && !rejected;

    // 可观察进展：清空重复窗口与无进展连击；失败重试不算进展。
    if (input.progress === true) {
      history = [];
      noProgressStreak = 0;
    }

    const previousCount = history.reduce((n, item) => (item.fingerprint === fingerprint ? n + 1 : n), 0);
    history.push({ fingerprint, at: Date.now() });
    while (history.length > windowSize) history.shift();

    if (failed) failStreak.set(name, (failStreak.get(name) || 0) + 1);
    else if (succeeded) failStreak.delete(name);

    if (failed || rejected) noProgressStreak += 1;
    else noProgressStreak = 0;

    const repeated = previousCount + 1;
    const currentFail = failStreak.get(name) || 0;
    const repeatLimit = readOnly ? readOnlySameToolLimit : sameToolLimit;
    const failLimitFor = readOnly ? readOnlyFailLimit : failLimit;

    // 被用户拒绝只累计无进展，不算工具的错，也不据此摘除工具。
    const tooRepeated = !rejected && repeated > repeatLimit;
    const tooManyFails = !rejected && currentFail >= failLimitFor;
    const stop = noProgressStreak >= stopThreshold;
    const warn =
      !stop &&
      (repeated >= reflectThreshold ||
        noProgressStreak >= reflectThreshold ||
        currentFail >= Math.max(2, failLimitFor - 1));

    const level = stop ? 'stop' : tooRepeated || tooManyFails ? 'disable' : warn ? 'reflect' : 'ok';
    const reason = stop ? 'noProgress' : tooManyFails ? 'toolFailStreak' : tooRepeated ? 'maxSameToolCalls' : '';
    const message =
      level === 'disable'
        ? tooManyFails
          ? '工具「' + name + '」连续 ' + currentFail + ' 次失败，已停止重试。'
          : '工具「' + name + '」重复调用过多，已暂停使用。'
        : level === 'stop'
          ? '检测到连续无进展，已触发安全停止。'
          : level === 'reflect'
            ? '动作多次没有产生可观察进展，请重新读取页面或调整策略。'
            : '';

    return {
      level,
      name,
      fingerprint,
      readOnly,
      repeated,
      failStreak: currentFail,
      noProgressStreak,
      reason,
      message,
    };
  }

  return {
    observe,
    reset() {
      history = [];
      noProgressStreak = 0;
      failStreak = new Map();
    },
    snapshot() {
      return {
        history: history.slice(),
        noProgressStreak,
        failStreak: Array.from(failStreak.entries()),
      };
    },
    restore(state) {
      if (!state || typeof state !== 'object') return;
      history = Array.isArray(state.history) ? state.history.slice(-windowSize) : [];
      noProgressStreak = Number(state.noProgressStreak) || 0;
      failStreak = new Map(Array.isArray(state.failStreak) ? state.failStreak : []);
    },
    getState() {
      return {
        history: history.slice(),
        noProgressStreak,
        failStreak: Array.from(failStreak.entries()),
      };
    },
  };
}
