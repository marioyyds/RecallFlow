// 桥接驱动的 **agent 任务 job**：让分钟级任务活过单次调用的超时。
//
// 为什么必须有它（数字都在代码/配置里，不需要估）：
//   · 桥接等扩展响应：RECALLFLOW_EXT_TIMEOUT_MS，默认 60000ms；
//   · DSH 的 MCP 工具调用：toolCallTimeoutMs，90000ms；
//   · 一条"把内容发到某站点"的流程：几十步 + 模型往返，**分钟级**。
// 所以 agent_task 不能同步等完成，必须「立刻返回 jobId + 按游标轮询进度」。
//
// 两条设计约束：
//   1. **单任务串行**。既有的「单站点串行、禁止并发」原则（见
//      docs/browser-channel-full-technical-plan.md 的 M2）在这里还有第二个理由：
//      DSH 自己也在驱动同一个浏览器，两个 agent 同时动手会互相踩标签页。
//      第二个 agent_task 直接**拒绝并返回当前 jobId** —— 不排队：
//      排队会让调用方以为"已经开跑了"。
//   2. **事件有上限**。页面快照这类结果可能很大，长时间任务会累积成千上万条；
//      无上限的缓冲就是一个稳定泄漏。超出后丢**最旧**的并记 omitted，
//      让读取方知道"你漏了多少"，而不是静默给出一段看起来连续的日志
//      （与 lib/assistant/context.js 的折叠语义一致：宁可显式标注缺口）。
//
// 本文件必须保持零依赖（扩展侧与 node 测试都要能直接载入）。

/** job 状态取值。与 lib/assistant/agent-state.js 的 RUN_STATUS 对齐，不另造同义词。 */
export const JOB_STATE = Object.freeze({
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  /** 长时间没有任何进展 —— 区别于 failed：不是"跑错了"，而是"不动了"。 */
  STALLED: 'stalled',
});

/**
 * 多久没有任何新事件就判定"不动了"（毫秒）。
 *
 * 为什么必须有这道闸：agent 循环里等审批是 `waitForToolApproval(port, ...)` 挂在 port 上，
 * 而**扩展侧没有超时兜底**（客户端侧那 60s/90s 只约束单次调用，管不到已经启动了的长任务）。
 * 于是一旦遇到"没人回答的审批"，job 会**永远**停在 running，
 * 调用方按文档一直轮询，却永远等不到终态 —— 而它看不出这是"卡住"还是"还在干活"。
 * 宁可显式报 stalled（附上该怎么办），也不要让调用方无限空转。
 */
export const JOB_STALL_MS = 90000;

/** 单 job 保留的事件条数上限。 */
export const JOB_EVENT_LIMIT = 400;

/** 保留多少个历史 job（最新的在前）。 */
export const JOB_KEEP = 20;

/**
 * 从事件流里抽出**最终答复**。
 *
 * 为什么必须单独抽：agent 的答复是以一串 `{type:'chunk', text}` 流式发出来的，
 * 而事件缓冲**有上限**（见文件头第 2 条：超上限丢最旧的）。
 * 一个跑了几十步的任务，最后那段答复完全可能把前面的 chunk 挤掉 ——
 * 于是调用方拿到的"结果"是空的，而任务其实成功了。
 * 因此取消/结束时必须把答复单独固化下来，不能依赖它还在事件里。
 *
 * 语义：取**最后一段连续 chunk 序列**，而不是把所有 chunk 拼起来 ——
 * 中间的工具调用之间可能夹着解释性文字，全拼会把「过程」当成「结论」。
 *
 * @param {Array<object>} events
 * @returns {string} 最终答复（没有则为空串）
 */
export function finalAnswerFrom(events) {
  const list = Array.isArray(events) ? events : [];
  // 先定位**最后一条 chunk**，再从那里往前走收连续 chunk。
  //
  // 为什么不从尾部直接往前扫：真实事件流在答复文本**之后**还跟着收尾元数据 ——
  // 实测一次真实任务的结尾是：
  //     chunk("。") → usage(totalTokens) → agent-state(completed) → end
  // 从尾部扫会在第一个非 chunk 事件（usage）上就停住，直接返回空。
  // 我第一版只跳过了 end / cancelled，于是线上表现为"任务成功但拿不到答复"，
  // 而单测是绿的 —— 因为单测的假事件流结尾恰好没有 usage/agent-state。
  // 教训：假数据少了一层收尾事件，就会把一个必然触发的缺陷测成通过。
  let last = -1;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i] && list[i].type === 'chunk') { last = i; break; }
  }
  if (last < 0) return '';
  // 从最后一条 chunk 往前走，遇到非 chunk 就停 —— 那就是最后一段连续输出。
  // 只取最后一段连续序列，而不是把所有 chunk 拼起来 ——
  // 中间的工具调用之间可能夹着解释性文字，全拼会把「过程」当成「结论」。
  const parts = [];
  for (let i = last; i >= 0; i -= 1) {
    const e = list[i];
    if (!e || e.type !== 'chunk') break;
    const text = typeof e.text === 'string' ? e.text : '';
    if (text) parts.unshift(text);
  }
  return parts.join('').trim();
}

function now() {
  return Date.now();
}

export class AgentJobStore {
  /**
   * @param {object} [options]
   * @param {number} [options.eventLimit] 单 job 事件上限
   * @param {number} [options.keep] 保留 job 数上限
   */
  constructor(options = {}) {
    this.eventLimit = Number(options.eventLimit) > 0 ? Number(options.eventLimit) : JOB_EVENT_LIMIT;
    this.keep = Number(options.keep) > 0 ? Number(options.keep) : JOB_KEEP;
    // 允许注入时钟与阈值，便于直测"卡住"这条边界（真实时钟要等 90 秒没法测）。
    this.stallMs = Number(options.stallMs) > 0 ? Number(options.stallMs) : JOB_STALL_MS;
    this.now = typeof options.now === 'function' ? options.now : now;
    /** @type {Map<string, object>} jobId -> job */
    this.jobs = new Map();
    this.seq = 0;
  }

  /**
   * 创建 job。**若已有 job 在跑则拒绝**（单任务串行，见文件头第 1 条）。
   * @returns {{ok:true,job:object}|{ok:false,error:string,runningJobId:string}}
   */
  create(meta = {}) {
    const running = this.running();
    if (running) {
      return {
        ok: false,
        error:
          '已有 agent 任务在运行中（jobId=' + running.id + '，开始于 ' +
          new Date(running.startedAt).toISOString() + '）。' +
          '浏览器里同时只能跑一个 agent 任务：两个同时动手会互相踩标签页。',
        runningJobId: running.id,
      };
    }
    const id = 'job-' + this.now().toString(36) + '-' + (++this.seq).toString(36);
    const job = {
      id,
      state: JOB_STATE.RUNNING,
      instruction: String(meta.instruction || '').slice(0, 2000),
      allowRisk: Array.isArray(meta.allowRisk) ? meta.allowRisk.slice() : [],
      tabId: Number.isInteger(Number(meta.tabId)) ? Number(meta.tabId) : null,
      startedAt: this.now(),
      updatedAt: this.now(),
      /** 下一个事件的 seq（从 1 开始，便于「sinceSeq=0 表示从头」的语义）。 */
      nextSeq: 1,
      events: [],
      /** 因上限被丢弃的最旧事件数 —— 必须暴露，否则读取方会以为日志是完整的。 */
      omitted: 0,
      result: '',
      error: '',
    };
    this.jobs.set(id, job);
    this.prune();
    return { ok: true, job };
  }

  /** 当前在跑的 job（若有）。 */
  running() {
    for (const job of this.jobs.values()) {
      if (job.state === JOB_STATE.RUNNING) return job;
    }
    return null;
  }

  get(id) {
    return this.jobs.get(String(id || '')) || null;
  }

  /**
   * 追加一条事件（来自扩展内 agent 的 emit）。
   * 事件里的 `type` 决定它是什么；这里不做解释，只做保序与限长。
   */
  append(id, event) {
    const job = this.get(id);
    if (!job) return null;
    const e = Object.assign({}, event, { seq: job.nextSeq++, at: this.now() });
    job.events.push(e);
    job.updatedAt = this.now();
    // 超上限丢最旧的：无上限缓冲就是稳定泄漏。丢多少要记下来（见文件头第 2 条）。
    while (job.events.length > this.eventLimit) {
      job.events.shift();
      job.omitted += 1;
    }
    return e;
  }

  /**
   * 标记 job 结束。
   * @param {string} id
   * @param {string} state JOB_STATE.COMPLETED / FAILED / CANCELLED
   * @param {object} [extra] { result, error }
   */
  finish(id, state, extra = {}) {
    const job = this.get(id);
    if (!job) return null;
    job.state = state;
    job.updatedAt = this.now();
    job.finishedAt = this.now();
    // 注意 extra.result 为空串时**不**赋值：relay 会传 `result: String(cur.result||'')`
    //（那时还没有答复），若把空串当"显式结果"写进去，下面的兜底就永远不会触发 ——
    // 表现为任务成功但 result 是空的。空串不是"结果"，它是"还没有结果"。
    if (extra.result) job.result = String(extra.result);
    // 成功结束但还没有 result 时，从事件里捞最终答复 ——
    // 不给的话调用方只看到 state=completed 而拿不到内容（见 finalAnswerFrom 的说明）。
    if (state === JOB_STATE.COMPLETED && !job.result) {
      job.result = finalAnswerFrom(job.events);
      job.resultFromEvents = Boolean(job.result);
    }
    if (extra.error !== undefined) job.error = String(extra.error || '');
    return job;
  }

  /**
   * 按游标读取进度。**只返回 sinceSeq 之后的事件**，用于轮询增量。
   *
   * @param {string} id
   * @param {number} [sinceSeq] 上次读到的 seq；缺省 0 = 从头
   * @returns {object|null} 读取结果；job 不存在返回 null
   */
  read(id, sinceSeq = 0) {
    const job = this.get(id);
    if (!job) return null;
    const since = Number(sinceSeq);
    const from = Number.isFinite(since) && since > 0 ? since : 0;
    const events = job.events.filter((e) => e.seq > from);
    // 只暴露调用方需要判断的东西：状态、是否有新东西、要不要继续轮询。
    return {
      jobId: job.id,
      state: job.state,
      running: job.state === JOB_STATE.RUNNING,
      instruction: job.instruction,
      tabId: job.tabId,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
      events,
      seq: events.length ? events[events.length - 1].seq : from,
      // 被丢弃的最旧事件数：读取方据此知道日志有缺口，而不是以为这就是全部。
      omitted: job.omitted,
      result: job.result,
      error: job.error,
    };
  }

  /** 请求取消。真正的终止由扩展侧对 AbortSignal 的响应完成。 */
  requestCancel(id) {
    const job = this.get(id);
    if (!job) return null;
    job.cancelRequested = true;
    job.updatedAt = this.now();
    return job;
  }

  /**
   * 把"长时间没有任何新事件"的在跑 job 判为 stalled。
   *
   * 为什么要有它：agent 循环等审批时挂在 port 上，**扩展侧没有超时兜底**
   *（客户端那 60s/90s 只约束单次调用，管不到已启动的长任务）。
   * 不判的话 job 会永远停在 running，调用方一直轮询却永远等不到终态，
   * 而且**看不出**这是"卡住"还是"还在干活"。
   *
   * 只在有人来查（status）或开新任务时调用 —— 不引入定时器：
   * service worker 会被回收，定时器本身就不可靠。
   *
   * @param {number} [nowMs] 当前时间（便于直测）
   * @returns {Array<object>} 本次被判定为 stalled 的 job
   */
  reapStale(nowMs) {
    const t = Number.isFinite(Number(nowMs)) ? Number(nowMs) : this.now();
    const out = [];
    for (const job of this.jobs.values()) {
      if (job.state !== JOB_STATE.RUNNING) continue;
      const idleMs = t - job.updatedAt;
      if (idleMs < this.stallMs) continue;
      job.state = JOB_STATE.STALLED;
      job.updatedAt = t;
      job.finishedAt = t;
      job.error =
        '任务已 ' + Math.round(idleMs / 1000) + 's 没有任何进展，判定为卡住。' +
        '常见原因：卡在一个没人能回答的审批上（桥接场景没有面板），或页面/网络长时间无响应。' +
        '请用 agent_task_cancel 收尾后重试；若反复卡在同一处，把该步骤改用原子工具（page_action）逐步驱动。';
      job.stalledAfterMs = idleMs;
      out.push(job);
    }
    return out;
  }

  /** 只保留最近 keep 个 job（已结束的优先丢弃）。 */
  prune() {
    if (this.jobs.size <= this.keep) return;
    const ordered = [...this.jobs.values()].sort((a, b) => a.startedAt - b.startedAt);
    for (const job of ordered) {
      if (this.jobs.size <= this.keep) break;
      if (job.state === JOB_STATE.RUNNING) continue; // 绝不丢在跑的
      this.jobs.delete(job.id);
    }
  }
}
