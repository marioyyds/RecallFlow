/** 单页面面板 run 的应用层生命周期。 */
export interface PanelRunPort {
  postMessage(message: unknown): unknown;
  disconnect(): void;
}

export type PanelRunRunner = (
  instruction: string,
  options?: unknown
) => Promise<unknown> | unknown;

export type PanelRunInterrupt = (source?: string) => Promise<void> | void;

export interface PanelRunSessionSnapshot {
  runId: string;
  running: boolean;
  hasPort: boolean;
}

export interface PanelRunSession {
  readonly isRunning: boolean;
  readonly runId: string;
  readonly port: PanelRunPort | null;
  readonly hasRunner: boolean;
  createRunId(): string;
  setRunId(runId: string): void;
  setRunning(running: boolean): void;
  finish(): void;
  setPort(port: PanelRunPort | null): void;
  clearPort(expected?: PanelRunPort | null): boolean;
  closePort(): void;
  bindRunner(runner: PanelRunRunner | null): void;
  invokeRunner(instruction: string, options?: unknown): Promise<unknown> | unknown;
  bindInterrupt(interrupt: PanelRunInterrupt | null): void;
  requestStop(source?: string): Promise<void> | void;
  snapshot(): PanelRunSessionSnapshot;
}

/**
 * 当前页面所拥有的一次 run 生命周期。
 *
 * 只保存跨多个 UI 区域共享的事实：runId、是否仍在运行、当前消息端口、
 * 续跑入口和停止入口。流式事件如何渲染、pending parts 如何归并仍留在 chat.ts。
 * 这样开始、断开、重连和结束不再分别修改多个模块级变量。
 */
export class PanelRunSessionState implements PanelRunSession {
  private running = false;
  private currentRunId = '';
  private currentPort: PanelRunPort | null = null;
  private runner: PanelRunRunner | null = null;
  private interrupt: PanelRunInterrupt | null = null;

  get isRunning(): boolean {
    return this.running;
  }

  get runId(): string {
    return this.currentRunId;
  }

  get port(): PanelRunPort | null {
    return this.currentPort;
  }

  get hasRunner(): boolean {
    return Boolean(this.runner);
  }

  createRunId(): string {
    return 'run-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }

  setRunId(runId: string): void {
    this.currentRunId = String(runId || '');
  }

  setRunning(running: boolean): void {
    this.running = running === true;
  }

  finish(): void {
    this.running = false;
  }

  setPort(port: PanelRunPort | null): void {
    this.currentPort = port || null;
  }

  /** 只在 expected 仍是当前端口时清除，避免旧端口的迟到 disconnect 摘掉新连接。 */
  clearPort(expected: PanelRunPort | null = null): boolean {
    if (expected && this.currentPort !== expected) return false;
    this.currentPort = null;
    return true;
  }

  closePort(): void {
    const activePort = this.currentPort;
    this.currentPort = null;
    if (!activePort) return;
    try {
      activePort.disconnect();
    } catch (error) {
      // 端口可能已经先被后台关闭。
    }
  }

  bindRunner(runner: PanelRunRunner | null): void {
    this.runner = typeof runner === 'function' ? runner : null;
  }

  invokeRunner(instruction: string, options?: unknown): Promise<unknown> | unknown {
    return this.runner ? this.runner(instruction, options) : null;
  }

  bindInterrupt(interrupt: PanelRunInterrupt | null): void {
    this.interrupt = typeof interrupt === 'function' ? interrupt : null;
  }

  requestStop(source?: string): Promise<void> | void {
    return this.interrupt ? this.interrupt(source) : undefined;
  }

  snapshot(): PanelRunSessionSnapshot {
    return {
      runId: this.currentRunId,
      running: this.running,
      hasPort: Boolean(this.currentPort),
    };
  }
}

export function createPanelRunSession(): PanelRunSession {
  return new PanelRunSessionState();
}
