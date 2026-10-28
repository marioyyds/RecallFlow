/** Cross-context messages with known panel/run shapes and a forward-compatible fallback. */

export interface GenericRuntimeMessage extends Record<string, unknown> {
  type: string;
}

export type PanelUiMessage =
  | { type: 'panel:open-active'; tabId?: number }
  | { type: 'panel:ui:get' }
  | { type: 'panel:ui:set'; open: boolean; scope?: 'global' | 'membership' };

export type PanelSessionMessage =
  | { type: 'panel:state' }
  | { type: 'panel:get'; id: string }
  | {
      type: 'panel:create';
      title?: string;
      messages?: Record<string, unknown>[];
      handoffId?: string;
      origin?: string;
    }
  | {
      type: 'panel:save';
      id: string;
      messages: Record<string, unknown>[];
      baseSeq?: number;
      allowShrink?: boolean;
      title?: string;
      handoffId?: string;
      lastRunId?: string;
      origin?: string;
    }
  | { type: 'panel:activate'; id: string }
  | { type: 'panel:rename'; id: string; title: string }
  | { type: 'panel:delete'; id: string }
  | { type: 'panel:lock'; id: string; runId: string; takeover?: boolean }
  | { type: 'panel:unlock'; id: string; runId: string };

export type RunSubscriptionMessage =
  | { type: 'panel:run:subscribe'; sessionId: string }
  | { type: 'panel:run:unsubscribe' }
  | { type: 'panel:run:stop'; runId?: string; sessionId?: string }
  | { type: 'panel:run:committed'; runId: string };

export type PanelMessage = PanelUiMessage | PanelSessionMessage | RunSubscriptionMessage;

const PANEL_SESSION_TYPES = new Set([
  'panel:state',
  'panel:get',
  'panel:create',
  'panel:save',
  'panel:activate',
  'panel:rename',
  'panel:delete',
  'panel:lock',
  'panel:unlock',
]);

export function isPanelUiMessage(message: GenericRuntimeMessage): message is PanelUiMessage {
  return message.type === 'panel:open-active' || message.type === 'panel:ui:get' || message.type === 'panel:ui:set';
}

export function isPanelSessionMessage(message: GenericRuntimeMessage): message is PanelSessionMessage {
  return PANEL_SESSION_TYPES.has(message.type);
}

export function isRunSubscriptionMessage(message: GenericRuntimeMessage): message is RunSubscriptionMessage {
  return message.type.startsWith('panel:run:');
}

export function isKnownPanelMessage(message: GenericRuntimeMessage): message is PanelMessage {
  return isPanelUiMessage(message) || isPanelSessionMessage(message) || isRunSubscriptionMessage(message);
}
