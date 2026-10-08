// 并行工具调度的**纯函数**部分：决定哪些工具调用可以成组并发。
//
// 背景：系统提示明确要求模型「一轮可以发出多个工具调用……不要一次一个地串行调用——
// 串行会成倍拉长耗时」（intent-router.js 的规则 12），但执行层一直是严格串行的
// `for (const tc of step.toolCalls) { await executeAnyTool(...) }`。
// 提示里承诺的并行从未兑现：模型在同一轮发出 3 个互不依赖的 web_search，
// 实际仍然一个接一个地等，20 秒的超时挨个承受。
//
// 这里只负责「挑出可以并发的相邻调用」这一件事，把执行留给调用方。
// 之所以做成纯函数并导出：这是整条并行路径上唯一能被穷举测试的部分，
// 而调度判错的代价（状态竞争 / 配对错乱）远高于执行本身。
//
// 安全边界（三条都必须满足，缺一不可）：
//   ① 工具被标记 parallelSafe（见 tool-metadata.js，逐个人工复核过的白名单）
//   ② 不需要用户审批（交互式等待无法并发）
//   ③ 已完成参数校验，且未被停用
// 另外只对**相邻**的合格调用成组：中间夹着一个写操作就必须断开，
// 否则会把「先读后写」的顺序倒过来。

/** 一组里最多排多少个调用。并发太多会同时压浏览器/网络，收益也早已饱和。 */
export const DEFAULT_MAX_BATCH = 4;

/**
 * 把一轮工具调用切成若干「可并发执行的相邻组」。
 *
 * @param {Array<{name:string,args:object}>} toolCalls 模型在本轮发出的工具调用（保持原顺序）
 * @param {object} opts
 * @param {(name:string,args:object,index:number)=>boolean} opts.isParallelSafe 是否属于并行白名单
 * @param {(name:string,args:object,index:number)=>boolean} [opts.shouldSkip] 是否需要退回串行路径
 * @param {number} [opts.maxBatch]
 * @returns {number[][]} 每组是**原数组下标**的列表；只返回长度 ≥ 2 的组
 *   （单个调用并发没有任何收益，交回串行路径 = 少一条代码路径 = 少一处风险）
 */
export function planParallelGroups(toolCalls, opts = {}) {
  const isParallelSafe = typeof opts.isParallelSafe === 'function' ? opts.isParallelSafe : () => false;
  const shouldSkip = typeof opts.shouldSkip === 'function' ? opts.shouldSkip : () => false;
  const maxBatch = Math.max(2, Number(opts.maxBatch) || DEFAULT_MAX_BATCH);

  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  const groups = [];
  let run = [];

  const flushRun = () => {
    for (let i = 0; i < run.length; i += maxBatch) {
      const chunk = run.slice(i, i + maxBatch);
      if (chunk.length >= 2) groups.push(chunk);
    }
    run = [];
  };

  calls.forEach((tc, index) => {
    const name = tc && tc.name;
    const args = (tc && tc.args) || {};
    const eligible = Boolean(name) && !shouldSkip(name, args, index) && isParallelSafe(name, args, index);
    if (eligible) run.push(index);
    else flushRun();
  });
  flushRun();

  return groups;
}

/** 把分组结果拍平成「下标 → 该组最大耗时」之类的诊断信息不需要，这里仅提供一句摘要。 */
export function describeGroups(groups) {
  if (!Array.isArray(groups) || !groups.length) return '无可并发组';
  return groups.map((g) => '[' + g.join(',') + ']').join(' ');
}
