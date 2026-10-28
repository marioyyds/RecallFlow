type Message = Record<string, any>;

export interface WorkspaceRouterPorts {
  openOptions(): Promise<void> | void;
  openManager(focusId: string): Promise<void> | void;
  sessionStorage: {
    get(keys: string | string[] | null): Promise<Record<string, any>>;
    set(items: Record<string, any>): Promise<void>;
  };
  saveHandoff(record: Message, options: Message): Promise<any>;
  getHandoff(id: unknown, options: Message): Promise<any>;
  listHandoffs(limit: unknown): Promise<any>;
}

export interface WorkspaceMessageSource {
  tabId: number | null;
}

/** Non-agent workspace commands: extension pages, legacy conversations, and handoff records. */
export class WorkspaceMessageRouter {
  private readonly ports: WorkspaceRouterPorts;

  constructor(ports: WorkspaceRouterPorts) {
    this.ports = ports;
  }

  matches(message: Message): boolean {
    const type = String(message && message.type || '');
    return type === 'openOptions' || type === 'openManager' || type.startsWith('conv:') || type.startsWith('handoff:');
  }

  async handle(message: Message, source: WorkspaceMessageSource): Promise<Message> {
    const type = String(message.type || '');
    if (type === 'openOptions') {
      await this.ports.openOptions();
      return { ok: true };
    }
    if (type === 'openManager') {
      await this.ports.openManager(String(message.focusId || ''));
      return { ok: true };
    }
    if (type === 'conv:save') {
      if (source.tabId != null && Array.isArray(message.conversation)) {
        await this.ports.sessionStorage.set({
          ['recallflow.conv.' + source.tabId]: {
            conversation: message.conversation,
            updatedAt: Date.now(),
          },
        });
      }
      return { ok: true };
    }
    if (type === 'conv:get') {
      if (source.tabId == null) return { conversation: [] };
      const store = await this.ports.sessionStorage.get('recallflow.conv.' + source.tabId);
      return { conversation: (store['recallflow.conv.' + source.tabId] || {}).conversation || [] };
    }
    if (type === 'handoff:save') {
      return this.ports.saveHandoff(message.record || {}, { trailItems: message.trailItems });
    }
    if (type === 'handoff:get') {
      return this.ports.getHandoff(message.id, {
        trailFrom: message.trailFrom,
        trailTo: message.trailTo,
      });
    }
    if (type === 'handoff:list') {
      return this.ports.listHandoffs(message.limit);
    }
    return { ok: false, error: '未知工作区消息：' + type };
  }
}
