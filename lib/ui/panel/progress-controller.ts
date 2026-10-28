import { composeProgressText } from '../../shared/utils.ts';

const STATE_LABELS: Record<string, string> = {
  created: '准备中',
  planning: '规划步骤',
  waiting_approval: '等待你确认',
  executing: '执行动作',
  observing: '查看结果',
  stopping: '停止中',
  paused: '已暂停',
  completed: '已完成',
  failed: '执行失败',
  cancelled: '已取消',
  timeout: '已达上限',
};

export function stateLabel(status: unknown): string {
  return STATE_LABELS[String(status || '').toLowerCase()] || '';
}

/** Owns elapsed-time progress state and its timer. */
export class PanelProgressController {
  el: any = null;
  messageEl: any = null;
  timeEl: any = null;
  timer: any = null;
  startedAt = 0;
  state = '';
  step = 0;
  max = 0;

  update(input: { state?: unknown; step?: unknown; max?: unknown; startedAt?: unknown } = {}): void {
    if (input.state !== undefined) this.state = String(input.state || '');
    if (input.step !== undefined) this.step = Number(input.step) || 0;
    if (input.max !== undefined) this.max = Number(input.max) || 0;
    if (input.startedAt !== undefined) this.startedAt = Number(input.startedAt) || 0;
    this.render();
  }

  render(): void {
    if (this.timeEl) {
      this.timeEl.textContent = this.startedAt
        ? '已用时 ' + Math.round((Date.now() - this.startedAt) / 1000) + 's'
        : '';
    }
    if (this.messageEl) this.messageEl.textContent = composeProgressText(this.step, this.max, this.state);
  }

  start(): void {
    this.startedAt = Date.now();
    this.state = '';
    this.step = 0;
    this.max = 0;
    if (this.el) this.el.classList.add('on');
    this.render();
    this.stopTimer();
    this.timer = setInterval(() => this.render(), 1000);
  }

  resume(startedAt?: unknown): void {
    if (!this.startedAt) this.startedAt = Number(startedAt) || Date.now();
    if (this.el) this.el.classList.add('on');
    this.render();
    if (!this.timer) this.timer = setInterval(() => this.render(), 1000);
  }

  stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  stop(): void {
    this.stopTimer();
    if (this.el) this.el.classList.remove('on');
    this.startedAt = 0;
    this.state = '';
    this.step = 0;
    this.max = 0;
  }
}
