import { disposeOverlays } from '../citation.ts';

/**
 * Page-level state owned by reversible DOM commands.
 *
 * Keeping this state in one explicit object makes a full reset deterministic and
 * prevents the command implementation from accumulating unrelated module-level
 * arrays.
 */
export class PageCommandSession {
  private readonly undoStack: (() => void)[] = [];
  private styleReverters: (() => void)[] = [];
  private timers: ReturnType<typeof setTimeout>[] = [];
  private readonly maxUndo: number;

  constructor(maxUndo = 40) {
    this.maxUndo = maxUndo;
  }

  pushUndo(revert: unknown): void {
    if (typeof revert !== 'function') return;
    this.undoStack.push(revert as () => void);
    if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
  }

  undo(): Record<string, unknown> {
    const revert = this.undoStack.pop();
    if (!revert) {
      return {
        ok: false,
        error: '没有可撤销的操作（仅输入/勾选/选择/改样式/滚动可撤销）',
      };
    }
    try {
      revert();
      return { ok: true, result: '已撤销上一步操作' };
    } catch (error) {
      return {
        ok: false,
        error: '撤销失败：' + (error instanceof Error ? error.message : String(error)),
      };
    }
  }

  addStyleReverter(revert: () => void): void {
    this.styleReverters.push(revert);
  }

  addTimer(timer: ReturnType<typeof setTimeout>): void {
    this.timers.push(timer);
  }

  reset(): void {
    try {
      disposeOverlays('cmd');
    } catch {}
    for (const revert of this.styleReverters) {
      try {
        revert();
      } catch {}
    }
    this.styleReverters = [];
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }
}

export const pageCommandSession = new PageCommandSession();
