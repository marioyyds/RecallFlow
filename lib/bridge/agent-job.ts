// Async bridge jobs so minute-scale agent runs survive a single-call timeout.
// One job runs at a time and event history is bounded.

export const JOB_STATE = Object.freeze({
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  STALLED: 'stalled',
} as const);

export type JobState = (typeof JOB_STATE)[keyof typeof JOB_STATE];

export const JOB_STALL_MS = 90000;
export const JOB_EVENT_LIMIT = 400;
export const JOB_KEEP = 20;

export interface AgentJobEvent {
  seq: number;
  at: number;
  type?: string;
  text?: string;
  [key: string]: unknown;
}

export interface AgentJob {
  id: string;
  state: JobState;
  instruction: string;
  allowRisk: string[];
  tabId: number | null;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  nextSeq: number;
  events: AgentJobEvent[];
  omitted: number;
  result: string;
  error: string;
  cancelRequested?: boolean;
  resultFromEvents?: boolean;
  stalledAfterMs?: number;
}

interface AgentJobOptions {
  eventLimit?: number;
  keep?: number;
  stallMs?: number;
  now?: () => number;
}

interface AgentJobMeta {
  instruction?: unknown;
  allowRisk?: unknown;
  tabId?: unknown;
}

interface JobExtra {
  result?: unknown;
  error?: unknown;
}

export type JobRead = {
  jobId: string;
  state: JobState;
  running: boolean;
  instruction: string;
  tabId: number | null;
  startedAt: number;
  updatedAt: number;
  events: AgentJobEvent[];
  seq: number;
  omitted: number;
  result: string;
  error: string;
};

/** Extract the last contiguous assistant chunk sequence. */
export function finalAnswerFrom(events: unknown): string {
  const list = Array.isArray(events) ? (events as Array<Record<string, unknown>>) : [];
  let last = -1;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index] && list[index].type === 'chunk') {
      last = index;
      break;
    }
  }
  if (last < 0) return '';

  const parts: string[] = [];
  for (let index = last; index >= 0; index -= 1) {
    const event = list[index];
    if (!event || event.type !== 'chunk') break;
    const text = typeof event.text === 'string' ? event.text : '';
    if (text) parts.unshift(text);
  }
  return parts.join('').trim();
}

function now(): number {
  return Date.now();
}

export class AgentJobStore {
  readonly eventLimit: number;
  readonly keep: number;
  readonly stallMs: number;
  readonly now: () => number;
  readonly jobs = new Map<string, AgentJob>();
  private seq = 0;

  constructor(options: AgentJobOptions = {}) {
    this.eventLimit = Number(options.eventLimit) > 0 ? Number(options.eventLimit) : JOB_EVENT_LIMIT;
    this.keep = Number(options.keep) > 0 ? Number(options.keep) : JOB_KEEP;
    this.stallMs = Number(options.stallMs) > 0 ? Number(options.stallMs) : JOB_STALL_MS;
    this.now = typeof options.now === 'function' ? options.now : now;
  }

  create(
    meta: AgentJobMeta = {}
  ): { ok: true; job: AgentJob } | { ok: false; error: string; runningJobId: string } {
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
    const job: AgentJob = {
      id,
      state: JOB_STATE.RUNNING,
      instruction: String(meta.instruction || '').slice(0, 2000),
      allowRisk: Array.isArray(meta.allowRisk) ? meta.allowRisk.map(String) : [],
      tabId: Number.isInteger(Number(meta.tabId)) ? Number(meta.tabId) : null,
      startedAt: this.now(),
      updatedAt: this.now(),
      nextSeq: 1,
      events: [],
      omitted: 0,
      result: '',
      error: '',
    };
    this.jobs.set(id, job);
    this.prune();
    return { ok: true, job };
  }

  running(): AgentJob | null {
    for (const job of this.jobs.values()) {
      if (job.state === JOB_STATE.RUNNING) return job;
    }
    return null;
  }

  get(id: unknown): AgentJob | null {
    return this.jobs.get(String(id || '')) || null;
  }

  append(id: unknown, event: Record<string, unknown>): AgentJobEvent | null {
    const job = this.get(id);
    if (!job) return null;
    const entry = Object.assign({}, event, {
      seq: job.nextSeq++,
      at: this.now(),
    }) as AgentJobEvent;
    job.events.push(entry);
    job.updatedAt = this.now();
    while (job.events.length > this.eventLimit) {
      job.events.shift();
      job.omitted += 1;
    }
    return entry;
  }

  finish(id: unknown, state: JobState, extra: JobExtra = {}): AgentJob | null {
    const job = this.get(id);
    if (!job) return null;
    job.state = state;
    job.updatedAt = this.now();
    job.finishedAt = this.now();
    if (extra.result) job.result = String(extra.result);
    if (state === JOB_STATE.COMPLETED && !job.result) {
      job.result = finalAnswerFrom(job.events);
      job.resultFromEvents = Boolean(job.result);
    }
    if (extra.error !== undefined) job.error = String(extra.error || '');
    return job;
  }

  read(id: unknown, sinceSeq = 0): JobRead | null {
    const job = this.get(id);
    if (!job) return null;
    const since = Number(sinceSeq);
    const from = Number.isFinite(since) && since > 0 ? since : 0;
    const events = job.events.filter((event) => event.seq > from);
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
      omitted: job.omitted,
      result: job.result,
      error: job.error,
    };
  }

  requestCancel(id: unknown): AgentJob | null {
    const job = this.get(id);
    if (!job) return null;
    job.cancelRequested = true;
    job.updatedAt = this.now();
    return job;
  }

  reapStale(nowMs?: unknown): AgentJob[] {
    const at = Number.isFinite(Number(nowMs)) ? Number(nowMs) : this.now();
    const stale: AgentJob[] = [];
    for (const job of this.jobs.values()) {
      if (job.state !== JOB_STATE.RUNNING) continue;
      const idleMs = at - job.updatedAt;
      if (idleMs < this.stallMs) continue;
      job.state = JOB_STATE.STALLED;
      job.updatedAt = at;
      job.finishedAt = at;
      job.error =
        '任务已 ' + Math.round(idleMs / 1000) + 's 没有任何进展，判定为卡住。' +
        '常见原因：卡在一个没人能回答的审批上（桥接场景没有面板），或页面/网络长时间无响应。' +
        '请用 agent_task_cancel 收尾后重试；若反复卡在同一处，把该步骤改用原子工具（page_action）逐步驱动。';
      job.stalledAfterMs = idleMs;
      stale.push(job);
    }
    return stale;
  }

  prune(): void {
    if (this.jobs.size <= this.keep) return;
    const ordered = [...this.jobs.values()].sort((a, b) => a.startedAt - b.startedAt);
    for (const job of ordered) {
      if (this.jobs.size <= this.keep) break;
      if (job.state === JOB_STATE.RUNNING) continue;
      this.jobs.delete(job.id);
    }
  }
}
