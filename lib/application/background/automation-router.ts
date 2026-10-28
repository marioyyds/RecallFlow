type Message = Record<string, any>;

export interface AutomationTab {
  id?: number;
  url?: string;
  active?: boolean;
}

export interface AutomationRouterPorts {
  queryTabs(query: Record<string, unknown>): Promise<AutomationTab[]>;
  requestTab(tabId: number, message: Message): Promise<any>;
  sendToTab(tabId: number, message: Message): void;
  createTab(options: Record<string, unknown>): Promise<void>;
  setLocal(items: Message): Promise<void>;
  notify(options: Message): Promise<void>;
  isOperableUrl(url: string): boolean;
  userscripts: {
    list(): Promise<any>;
    install(url: unknown): Promise<any>;
    preview(url: unknown): Promise<any>;
    installCode(code: unknown, label: unknown): Promise<any>;
    previewCode(code: unknown): Promise<any>;
    update(id: unknown): Promise<any>;
    updateAll(): Promise<any>;
    setEnabled(id: unknown, enabled: unknown): Promise<any>;
    uninstall(id: unknown): Promise<any>;
    search(query: unknown): Promise<any>;
    runOnTab(tabId: number, id: unknown): Promise<any>;
    xhr(details: unknown): Promise<any>;
  };
}

export interface AutomationMessageSource {
  tabId: number | null;
  url: string;
}

/** Routes cross-context browser automation messages; Chrome details are injected as ports. */
export class AutomationMessageRouter {
  private readonly ports: AutomationRouterPorts;

  constructor(ports: AutomationRouterPorts) {
    this.ports = ports;
  }

  matches(message: Message): boolean {
    const type = String(message && message.type || '');
    return (
      type === 'pageCommand' ||
      type === 'pick:start' ||
      type === 'pick:result' ||
      type === 'pick:cancel' ||
      type.startsWith('userscript:')
    );
  }

  handle(message: Message, source: AutomationMessageSource): Promise<Message> | null {
    if (!this.matches(message)) return null;
    const type = String(message.type || '');
    if (type === 'pick:start') return this.handlePickStart(source);
    if (type === 'pick:result') return this.handlePickResult(message, source);
    if (type === 'pick:cancel') {
      if (source.tabId != null) this.ports.sendToTab(source.tabId, { type: 'kbPickCancel' });
      return Promise.resolve({ ok: true });
    }
    if (type === 'pageCommand') return this.handlePageCommand(message);
    return this.handleUserscript(message);
  }

  private async handlePickStart(source: AutomationMessageSource) {
    if (source.tabId != null) this.ports.sendToTab(source.tabId, { type: 'kbPickStart' });
    return { ok: true };
  }

  private async handlePickResult(message: Message, source: AutomationMessageSource) {
    const picked = Array.isArray(message.pickedList)
      ? message.pickedList
      : message.picked
        ? [message.picked]
        : [];
    if (picked.length) {
      const timestamp = Date.now();
      const base = { tabId: source.tabId, pageUrl: source.url, ts: timestamp };
      await this.ports.setLocal({
        'recallflow.lastPicked': Object.assign({}, picked[0], base),
        'recallflow.lastPickedList': picked.map((item: Message) => Object.assign({}, item, base)),
      });
    }
    if (source.tabId != null) {
      this.ports.sendToTab(source.tabId, { type: 'kbPickCancel' });
      this.ports.sendToTab(source.tabId, { type: 'kbPickResult', pickedList: picked });
    }
    return { ok: true };
  }

  private async handlePageCommand(message: Message) {
    const tabs = await this.ports.queryTabs({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab || !tab.id) return { ok: false, error: '无活动标签页' };
    const response = await this.ports.requestTab(tab.id, {
      type: 'kbPageCommand',
      command: message.command,
      params: message.params || {},
    });
    return response || { ok: false, error: '页面命令无响应' };
  }

  private async handleUserscript(message: Message) {
    const scripts = this.ports.userscripts;
    switch (message.type) {
      case 'userscript:list':
        return { ok: true, scripts: await scripts.list() };
      case 'userscript:install':
        return scripts.install(message.url);
      case 'userscript:preview':
        return scripts.preview(message.url);
      case 'userscript:installCode':
        return scripts.installCode(message.code, message.label);
      case 'userscript:previewCode':
        return scripts.previewCode(message.code);
      case 'userscript:update':
        return scripts.update(message.id);
      case 'userscript:updateAll':
        return Object.assign({ ok: true }, await scripts.updateAll());
      case 'userscript:toggle':
        return scripts.setEnabled(message.id, message.enabled);
      case 'userscript:uninstall':
        return scripts.uninstall(message.id);
      case 'userscript:search':
        return { ok: true, list: await scripts.search(message.q) };
      case 'userscript:runOnTab': {
        const tabs = await this.ports.queryTabs({ currentWindow: true });
        const webTabs = tabs.filter((tab) => tab.url && this.ports.isOperableUrl(tab.url));
        const tab = webTabs.find((item) => item.active) || webTabs[0];
        if (!tab || !tab.id) return { ok: false, error: '没有可运行的网页标签页' };
        return (await scripts.runOnTab(tab.id, message.id)) || { ok: false, error: '脚本执行无响应' };
      }
      case 'userscript:xhr':
        return scripts.xhr(message.details);
      case 'userscript:openTab':
        await this.ports.createTab({ url: message.url, active: message.active !== false });
        return { ok: true };
      case 'userscript:notify':
        await this.ports.notify({ title: message.title || 'RecallFlow', text: message.text || '' });
        return { ok: true };
      default:
        return { ok: false, error: '未知用户脚本消息：' + message.type };
    }
  }
}
