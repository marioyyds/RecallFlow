import type { RunChannelLike, RunControllerLike, RunRecordLike, TabRunRegistry } from './run-registry.ts';

export interface RunHubLike {
  findBySession(sessionId: string): any;
  snapshot(runId: string): any;
  push(runId: string, event: any): void;
}

export interface RunLifecyclePorts {
  sendToTab(tabId: number, message: Record<string, unknown>): void;
}

export interface RunLifecycleStats {
  starts: number;
  reattaches: number;
  aborts: number;
  hubDeltas: number;
  hubErrors?: number;
  lastHubError?: string;
}

export interface RunStopResult {
  ok: boolean;
  code?: string;
  error?: string;
  runId?: string;
  sessionId?: string;
  ownerTabId?: number;
}

/**
 * Service Worker 的 run 生命周期服务。
 * 负责 abort 宽限、按 runId/sessionId 定位 owner、停止请求和标签页清理。
 */
export class RunLifecycleService {
  readonly stats: RunLifecycleStats = {
    starts: 0,
    reattaches: 0,
    aborts: 0,
    hubDeltas: 0,
  };

  private readonly registry: TabRunRegistry;
  private readonly hub: RunHubLike;
  private readonly ports: RunLifecyclePorts;
  private readonly graceMs: number;

  constructor(
    registry: TabRunRegistry,
    hub: RunHubLike,
    ports: RunLifecyclePorts,
    graceMs = 8000
  ) {
    this.registry = registry;
    this.hub = hub;
    this.ports = ports;
    this.graceMs = graceMs;
  }

  clearAbortTimer(runId: unknown): void {
    this.registry.clearAbortTimer(runId);
  }

  scheduleAbortIfNoReattach(runId: unknown, tabId: number | null | undefined): void {
    const id = String(runId || '');
    this.registry.scheduleAbort(id, this.graceMs, () => {
      const record = this.registry.runFor(tabId);
      if (!record || String(record.runId || '') !== id) return;
      const channel = this.registry.channelFor(id);
      if (channel && channel.isAttached()) return;
      const controller = record.controller;
      if (controller && !controller.__rfFinished) {
        this.stats.aborts += 1;
        try {
          controller.abort();
        } catch (error) {}
      }
    });
  }

  requestStop(params: Record<string, any>, requesterTabId: number | null | undefined): RunStopResult {
    const wantedRunId = String(params.runId || '');
    const wantedSessionId = String(params.sessionId || '');
    let owner: { tabId: number; record: RunRecordLike } | null = null;

    for (const [tabId, record] of this.registry.runs) {
      if (!record) continue;
      if (wantedRunId && String(record.runId || '') !== wantedRunId) continue;
      if (!wantedRunId && wantedSessionId && String(record.sessionId || '') !== wantedSessionId) continue;
      owner = { tabId: Number(tabId), record };
      break;
    }

    if (!owner && wantedSessionId) {
      const snapshot = this.hub.findBySession(wantedSessionId);
      if (snapshot && snapshot.ownerTabId != null) {
        const tabId = Number(snapshot.ownerTabId);
        owner = { tabId, record: this.registry.runFor(tabId) || {} };
      }
    }

    const runId = String(owner?.record.runId || wantedRunId);
    const snapshot = runId ? this.hub.snapshot(runId) : null;
    if (!snapshot || snapshot.status !== 'running') {
      return { ok: false, code: 'not-running', error: '该任务已结束，无需停止' };
    }
    if (!owner) return { ok: false, code: 'owner-missing', error: '找不到任务所属标签页' };

    const controller = this.registry.controllerFor(owner.tabId);
    if (!controller || controller.signal.aborted) {
      return { ok: false, code: 'already-stopping', error: '该任务已在停止中' };
    }

    this.registry.updateRun(owner.tabId, owner.record, { resumable: false });
    this.clearAbortTimer(runId);
    this.hub.push(runId, {
      type: 'stop-requested',
      byTabId: requesterTabId == null ? null : Number(requesterTabId),
    });

    this.stats.aborts += 1;
    try {
      controller.abort();
    } catch (error) {}

    if (requesterTabId != null && Number(requesterTabId) !== owner.tabId) {
      this.ports.sendToTab(owner.tabId, {
        type: 'run:stopped',
        runId,
        sessionId: snapshot.sessionId || wantedSessionId,
        remote: true,
      });
    }

    return {
      ok: true,
      runId,
      sessionId: snapshot.sessionId || wantedSessionId,
      ownerTabId: owner.tabId,
    };
  }

  cleanupTab(tabId: number): void {
    const record = this.registry.runFor(tabId);
    if (record?.runId) {
      this.clearAbortTimer(record.runId);
      this.registry.deleteChannel(record.runId);
    }
    const controller = this.registry.controllerFor(tabId);
    if (controller && !controller.__rfFinished) {
      this.stats.aborts += 1;
      try {
        controller.abort();
      } catch (error) {}
    }
    this.registry.deleteController(tabId);
    this.registry.deleteRun(tabId);
  }

  setController(tabId: number, controller: RunControllerLike): void {
    this.registry.setController(tabId, controller);
  }

  setChannel(runId: unknown, channel: RunChannelLike): void {
    this.registry.setChannel(runId, channel);
  }

  deleteChannel(runId: unknown): void {
    this.registry.deleteChannel(runId);
  }

  setRun(tabId: number, record: RunRecordLike): void {
    this.registry.setRun(tabId, record);
  }
}
