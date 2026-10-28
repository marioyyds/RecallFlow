/** 面板可见性的应用层状态机。 */
export type PanelVisibilityScope = 'global' | 'membership';

export interface PanelUiSnapshot {
  seq: number;
  open: boolean;
}

export interface PanelVisibilityController {
  readonly isOpen: boolean;
  readonly canPublish: boolean;
  readonly ready: Promise<void> | null;
  snapshot(): PanelUiSnapshot;
  publish(open: boolean, scope?: PanelVisibilityScope): Promise<unknown>;
  apply(ui: unknown): Promise<boolean>;
  syncOnInit(): Promise<void>;
  withSuppressed<T>(task: () => T | Promise<T>): Promise<T>;
}

export interface PanelVisibilityDeps {
  send(type: string, payload?: Record<string, unknown>): Promise<unknown>;
  isMounted(): boolean;
  open(): void | Promise<void>;
  close(): void | Promise<void>;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' ? (value as UnknownRecord) : null;
}

function readUi(value: unknown): PanelUiSnapshot | null {
  const record = asRecord(value);
  if (!record) return null;
  const nextSeq = Number(record.seq);
  if (!Number.isFinite(nextSeq)) return null;
  return { seq: nextSeq, open: record.open === true };
}

/**
 * 全浏览器共享的面板开合状态。
 *
 * 这个对象独占序号、权威开合值、抑制广播计数和初始化同步 Promise，避免这些字段
 * 分别散落在 chat.ts 的模块作用域里。远端状态是否应用、本地是否允许广播，都由
 * 这里统一判断；具体如何创建/销毁 DOM 仍通过 open/close 回调注入。
 */
export class PanelVisibilityState implements PanelVisibilityController {
  private readonly deps: PanelVisibilityDeps;
  private seq = 0;
  private open = false;
  private suppressDepth = 0;
  private initPromise: Promise<void> | null = null;

  constructor(deps: PanelVisibilityDeps) {
    this.deps = deps;
  }

  get isOpen(): boolean {
    return this.open;
  }

  get canPublish(): boolean {
    return this.suppressDepth === 0;
  }

  get ready(): Promise<void> | null {
    return this.initPromise;
  }

  snapshot(): PanelUiSnapshot {
    return { seq: this.seq, open: this.open };
  }

  async publish(open: boolean, scope: PanelVisibilityScope = 'global'): Promise<unknown> {
    this.open = open === true;
    if (!this.canPublish) return null;

    try {
      const response = await this.deps.send('panel:ui:set', {
        open: this.open,
        scope: scope === 'membership' ? 'membership' : 'global',
      });
      this.acceptResponse(response);
      return response;
    } catch (error) {
      return null;
    }
  }

  async apply(ui: unknown): Promise<boolean> {
    const next = readUi(ui);
    if (!next || next.seq < this.seq) return false;

    this.seq = next.seq;
    this.open = next.open;
    if (this.open) {
      if (!this.deps.isMounted()) {
        await this.withSuppressed(() => this.deps.open());
      }
      await this.publish(true, 'membership');
    } else {
      if (this.deps.isMounted()) {
        await this.withSuppressed(() => this.deps.close());
      }
      await this.publish(false, 'membership');
    }
    return true;
  }

  syncOnInit(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      let response: unknown = null;
      try {
        response = await this.deps.send('panel:ui:get');
      } catch (error) {
        return;
      }
      const message = asRecord(response);
      if (!message || message.ok !== true) return;
      const next = readUi(message.ui);
      if (!next || next.seq < this.seq) return;
      this.seq = next.seq;
      this.open = next.open;
      if (this.open) await this.apply(message.ui);
    })();
    return this.initPromise;
  }

  async withSuppressed<T>(task: () => T | Promise<T>): Promise<T> {
    this.suppressDepth += 1;
    try {
      return await task();
    } finally {
      this.suppressDepth -= 1;
    }
  }

  private acceptResponse(response: unknown): void {
    const message = asRecord(response);
    if (!message || message.ok !== true) return;
    const next = readUi(message.ui);
    if (!next || next.seq < this.seq) return;
    this.seq = next.seq;
    this.open = next.open;
  }
}

export function createPanelVisibilityController(
  deps: PanelVisibilityDeps
): PanelVisibilityController {
  return new PanelVisibilityState(deps);
}
