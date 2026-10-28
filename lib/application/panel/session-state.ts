/** Shared panel-session state that spans persistence, switching, and run locks. */
export class PanelSessionState {
  conversation: any[] = [];
  panelSessionId = '';
  panelSessionSeq = 0;
  panelSessionList: any[] = [];
  panelSessionActiveId = '';
  panelSessionSaveChain: Promise<any> = Promise.resolve();
  panelSessionSwitchInFlight = false;
  deferredRemoteSessionId = '';
  panelSessionLockHeld = false;
  panelSessionLockRunId = '';

  adoptIdentity(id: unknown, seq: unknown): void {
    this.panelSessionId = String(id || '');
    this.panelSessionSeq = Number(seq) || 0;
  }

  replaceConversation(messages: unknown): void {
    this.conversation = Array.isArray(messages) ? messages : [];
  }

  enqueueSave<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.panelSessionSaveChain.catch(() => {}).then(operation);
    this.panelSessionSaveChain = queued;
    return queued;
  }

  resetLock(): void {
    this.panelSessionLockHeld = false;
    this.panelSessionLockRunId = '';
  }
}
