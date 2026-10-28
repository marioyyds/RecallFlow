/** Service Worker 的运行注册表。 */
export interface RunControllerLike extends AbortController {
  __rfFinished?: boolean;
}

export interface RunChannelLike {
  isAttached(): boolean;
  attach(port: unknown, options?: unknown): boolean;
  detach(port?: unknown): void;
  resume(): void;
  postMessage(message: unknown): void;
  onMessage: { addListener(listener: (message: any) => void): void };
}

export interface RunRecordLike {
  runId?: unknown;
  sessionId?: unknown;
  resumable?: unknown;
  channel?: unknown;
  controller?: RunControllerLike | null;
  [key: string]: unknown;
}

export interface TabRunRegistry {
  readonly runs: Iterable<[number, RunRecordLike]>;
  controllerFor(tabId: number): RunControllerLike | null;
  setController(tabId: number, controller: RunControllerLike): void;
  deleteController(tabId: number): void;
  runFor(tabId: number | null | undefined): RunRecordLike | null;
  setRun(tabId: number, record: RunRecordLike): void;
  updateRun(tabId: number, record: RunRecordLike, patch: Partial<RunRecordLike>): RunRecordLike;
  deleteRun(tabId: number): void;
  channelFor(runId: unknown): RunChannelLike | null;
  setChannel(runId: unknown, channel: RunChannelLike): void;
  deleteChannel(runId: unknown): void;
  clearAbortTimer(runId: unknown): void;
  scheduleAbort(runId: unknown, delayMs: number, callback: () => void): void;
}

/**
 * service worker 内的 tab/run 映射。
 *
 * 这组 Map 必须一起维护：标签页关闭、端口断开、reattach 和 run 收尾都会同时
 * 涉及 controller、最近 run、输出通道与 abort 宽限定时器。集中到一个对象后，
 * 清理顺序和旧 runId 的迟到事件不再散落在每个消息分支里。
 */
export class TabRunRegistryState implements TabRunRegistry {
  private readonly controllers = new Map<number, RunControllerLike>();
  private readonly tabRecords = new Map<number, RunRecordLike>();
  private readonly channels = new Map<string, RunChannelLike>();
  private readonly abortTimers = new Map<string, ReturnType<typeof setTimeout>>();

  get runs(): Iterable<[number, RunRecordLike]> {
    return this.tabRecords.entries();
  }

  controllerFor(tabId: number): RunControllerLike | null {
    return this.controllers.get(tabId) || null;
  }

  setController(tabId: number, controller: RunControllerLike): void {
    this.controllers.set(tabId, controller);
  }

  deleteController(tabId: number): void {
    this.controllers.delete(tabId);
  }

  runFor(tabId: number | null | undefined): RunRecordLike | null {
    if (tabId == null) return null;
    return this.tabRecords.get(tabId) || null;
  }

  setRun(tabId: number, record: RunRecordLike): void {
    this.tabRecords.set(tabId, record);
  }

  updateRun(tabId: number, record: RunRecordLike, patch: Partial<RunRecordLike>): RunRecordLike {
    const next = Object.assign({}, record, patch);
    this.tabRecords.set(tabId, next);
    return next;
  }

  deleteRun(tabId: number): void {
    this.tabRecords.delete(tabId);
  }

  channelFor(runId: unknown): RunChannelLike | null {
    return this.channels.get(String(runId || '')) || null;
  }

  setChannel(runId: unknown, channel: RunChannelLike): void {
    this.channels.set(String(runId || ''), channel);
  }

  deleteChannel(runId: unknown): void {
    this.channels.delete(String(runId || ''));
  }

  clearAbortTimer(runId: unknown): void {
    const key = String(runId || '');
    const timer = this.abortTimers.get(key);
    if (!timer) return;
    clearTimeout(timer);
    this.abortTimers.delete(key);
  }

  scheduleAbort(runId: unknown, delayMs: number, callback: () => void): void {
    const key = String(runId || '');
    this.clearAbortTimer(key);
    const timer = setTimeout(() => {
      this.abortTimers.delete(key);
      callback();
    }, delayMs);
    this.abortTimers.set(key, timer);
  }
}

export function createTabRunRegistry(): TabRunRegistry {
  return new TabRunRegistryState();
}
