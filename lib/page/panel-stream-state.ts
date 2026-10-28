export interface PanelStreamSnapshot {
  content?: unknown;
  narration?: unknown;
  parts?: unknown;
}

export interface PanelStreamState {
  readonly content: string;
  readonly narration: string;
  readonly previousNarration: string;
  readonly started: boolean;
  readonly parts: ReadonlyArray<any>;
  readonly verifyPass: any | null;
  readonly budgetStopped: boolean;
  readonly responseText: string;
  reset(): void;
  beginNew(): void;
  restore(snapshot: PanelStreamSnapshot | null | undefined): void;
  appendChunk(text: unknown): void;
  appendPart(part: any): void;
  flushNarration(): string | null;
  setVerifyPass(part: any): void;
  commitVerifyPass(): void;
  markBudgetStopped(): void;
  hasPartial(): boolean;
}

/**
 * 当前流式回答的纯数据状态。
 *
 * 它不接触 DOM，只维护正文累积、当前叙述段、已定稿 parts、校验提示和停止标记。
 * 面板层负责把这些事实渲染成元素；运行层负责决定何时 append 或收尾。
 */
export class PanelStreamAccumulator implements PanelStreamState {
  private contentValue = '';
  private narrationValue = '';
  private previousNarrationValue = '';
  private startedValue = false;
  private partsValue: any[] = [];
  private verifyPassValue: any | null = null;
  private budgetStoppedValue = false;

  get content(): string {
    return this.contentValue;
  }

  get narration(): string {
    return this.narrationValue;
  }

  get previousNarration(): string {
    return this.previousNarrationValue;
  }

  get started(): boolean {
    return this.startedValue;
  }

  get parts(): ReadonlyArray<any> {
    return this.partsValue;
  }

  get verifyPass(): any | null {
    return this.verifyPassValue;
  }

  get budgetStopped(): boolean {
    return this.budgetStoppedValue;
  }

  get responseText(): string {
    return this.narrationValue || this.previousNarrationValue || this.contentValue;
  }

  reset(): void {
    this.contentValue = '';
    this.narrationValue = '';
    this.previousNarrationValue = '';
    this.startedValue = false;
    this.partsValue = [];
    this.verifyPassValue = null;
    this.budgetStoppedValue = false;
  }

  beginNew(): void {
    this.reset();
  }

  restore(snapshot: PanelStreamSnapshot | null | undefined): void {
    const source = snapshot || {};
    this.contentValue = String(source.content || '');
    this.narrationValue = String(source.narration || '');
    this.partsValue = Array.isArray(source.parts)
      ? source.parts.map((part: any) => Object.assign({}, part))
      : [];
    this.previousNarrationValue = '';
    this.startedValue = true;
    this.verifyPassValue = null;
    this.budgetStoppedValue = false;
  }

  appendChunk(text: unknown): void {
    const piece = String(text || '');
    if (!piece) return;
    this.contentValue += piece;
    this.narrationValue += piece;
    this.startedValue = true;
  }

  appendPart(part: any): void {
    if (!part) return;
    this.partsValue.push(part);
  }

  /** 定稿最后一条正文之前的叙述段；返回被定稿的文本，没有则返回 null。 */
  flushNarration(): string | null {
    const text = this.narrationValue;
    if (!text) return null;
    this.previousNarrationValue = text;
    this.partsValue.push({ type: 'narration', text });
    this.narrationValue = '';
    return text;
  }

  setVerifyPass(part: any): void {
    this.verifyPassValue = part || null;
  }

  commitVerifyPass(): void {
    if (!this.verifyPassValue) return;
    this.partsValue.push(this.verifyPassValue);
    this.verifyPassValue = null;
  }

  markBudgetStopped(): void {
    this.budgetStoppedValue = true;
  }

  hasPartial(): boolean {
    return Boolean(this.narrationValue.trim());
  }
}

export function createPanelStreamState(): PanelStreamState {
  return new PanelStreamAccumulator();
}
