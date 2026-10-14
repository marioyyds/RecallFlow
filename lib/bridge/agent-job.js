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
});

/** 单 job 保留的事件条数上限。 */
export const JOB_EVENT_LIMIT = 400;

/** 保留多少个历史 job（最新的在前）。 */
export const JOB_KEEP = 20;

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
    const id = 'job-' + now().toString(36) + '-' + (++this.seq).toString(36);
    const job = {
      id,
      state: JOB_STATE.RUNNING,
      instruction: String(meta.instruction || '').slice(0, 2000),
      allowRisk: Array.isArray(meta.allowRisk) ? meta.allowRisk.slice() : [],
      tabId: Number.isInteger(Number(meta.tabId)) ? Number(meta.tabId) : null,
      startedAt: now(),
      updatedAt: now(),
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
    const e = Object.assign({}, event, { seq: job.nextSeq++ , at: now() });
    job.events.push(e);
    job.updatedAt = now();
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
    job.updatedAt = now();
    job.finishedAt = now();
    if (extra.result !== undefined) job.result = String(extra.result || '');
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
    job.updatedAt = now();
    return job;
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
