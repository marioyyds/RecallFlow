import type { PanelSessionStore } from '../../shared/panel-sessions.ts';

type Message = Record<string, any>;

export interface PanelMessageSource {
  tabId: number | null;
  url?: string;
}

export interface PanelRouterPorts {
  store: PanelSessionStore;
  ensureSessions(): Promise<unknown>;
  broadcastSessions(state: Message, sourceTabId: number | null): void;
  broadcastUi(ui: Message, sourceTabId: number | null): void;
  sendToTab(tabId: number, message: Message): void;
  removeScreenshots(sessionId: string): Promise<unknown>;
}

function summary(state: Message) {
  const value = state || {};
  return {
    sessions: Array.isArray(value.sessions) ? value.sessions : [],
    activeId: String(value.activeId || ''),
    seq: Number(value.seq) || 0,
  };
}

/**
 * Application-level router for panel visibility and shared panel sessions.
 * Chrome tab and screenshot concerns are supplied through ports.
 */
export class PanelMessageRouter {
  private readonly ports: PanelRouterPorts;

  constructor(ports: PanelRouterPorts) {
    this.ports = ports;
  }

  matches(message: Message): boolean {
    const type = String(message && message.type || '');
    return (
      type === 'panel:open-active' ||
      type === 'panel:ui:get' ||
      type === 'panel:ui:set' ||
      /^panel:(state|get|create|save|activate|rename|delete|lock|unlock)$/.test(type)
    );
  }

  async handle(message: Message, source: PanelMessageSource): Promise<Message> {
    const type = String(message.type || '');
    if (type === 'panel:open-active') {
      const requested = Number(message.tabId);
      const tabId = Number.isInteger(requested) && requested > 0 ? requested : source.tabId;
      if (tabId == null || !Number.isInteger(tabId) || tabId <= 0) {
        return { ok: false, error: '缺少目标标签页' };
      }
      await this.ports.ensureSessions();
      const result: any = await this.ports.store.setUi({ open: true, tabId, scope: 'global' });
      this.ports.broadcastUi(result.ui, null);
      return { ok: true, ui: result.ui };
    }

    if (type === 'panel:ui:get') {
      return { ok: true, ui: await this.ports.store.getUi() };
    }

    if (type === 'panel:ui:set') {
      const result: any = await this.ports.store.setUi({
        open: message.open === true,
        tabId: source.tabId,
        scope: message.scope === 'membership' ? 'membership' : 'global',
      });
      if (result.changed) this.ports.broadcastUi(result.ui, source.tabId);
      return { ok: true, ui: result.ui };
    }

    await this.ports.ensureSessions();
    const store = this.ports.store;
    let result: any;
    if (type === 'panel:state') {
      return Object.assign({ ok: true }, summary(await store.list()));
    }
    if (type === 'panel:get') {
      const state: any = await store.get(message.id);
      return {
        ok: true,
        session: state.session || null,
        activeId: state.activeId || '',
        sessions: state.sessions || [],
      };
    }
    if (type === 'panel:create') {
      result = await store.create({
        title: message.title,
        messages: Array.isArray(message.messages) ? message.messages : [],
        handoffId: message.handoffId,
        origin: source.url || message.origin || '',
      });
    } else if (type === 'panel:save') {
      result = await store.save({
        id: message.id,
        messages: message.messages,
        baseSeq: message.baseSeq,
        allowShrink: message.allowShrink === true,
        title: message.title,
        handoffId: message.handoffId,
        lastRunId: message.lastRunId,
        origin: message.origin,
        tabId: source.tabId,
      });
    } else if (type === 'panel:activate') {
      result = await store.activate(message.id);
    } else if (type === 'panel:rename') {
      result = await store.rename(message.id, message.title);
    } else if (type === 'panel:delete') {
      result = await store.remove(message.id);
      if (result && result.ok) {
        await this.ports.removeScreenshots(String(message.id || '')).catch(() => {});
      }
    } else if (type === 'panel:lock') {
      result = await store.lock({
        id: message.id,
        runId: message.runId,
        tabId: source.tabId,
        takeover: message.takeover === true,
      });
      const previous = result && result.ok && message.takeover === true && result.lock
        ? result.lock.previous
        : null;
      if (previous && Number(previous.tabId)) {
        this.ports.sendToTab(Number(previous.tabId), {
          type: 'panel:lock-lost',
          id: String(message.id || ''),
          runId: String(previous.runId || ''),
        });
      }
    } else if (type === 'panel:unlock') {
      result = await store.unlock({ id: message.id, runId: message.runId });
      if (result && result.ok) {
        const state = await store.list();
        result.sessions = state.sessions || [];
        result.activeId = state.activeId || '';
      }
    }
    const response = Object.assign({ ok: true }, result || {});
    if (result && result.ok && Array.isArray(result.sessions)) {
      this.ports.broadcastSessions(result, source.tabId);
    }
    return response;
  }
}
