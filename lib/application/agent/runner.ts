import type { AgentSettings } from './types.ts';
import type { KnowledgeBook } from '../../shared/store.ts';

export interface AgentEventPort {
  postMessage(message: unknown): void;
  onMessage: { addListener(listener: (message: any) => void): void };
}

export interface AgentRunRequest {
  port: AgentEventPort;
  payload: Record<string, any>;
  settings: AgentSettings;
  book: KnowledgeBook;
  signal: AbortSignal;
  tabId?: number;
  observeEvent?: (event: any) => void;
}

export type AgentStreamFunction = (
  port: AgentEventPort,
  payload: Record<string, any>,
  settings: AgentSettings,
  book: KnowledgeBook,
  signal: AbortSignal,
  tabId: number | undefined,
  observeEvent?: (event: any) => void
) => Promise<void>;

/** Agent 运行用例的稳定入口，Background 不再直接拼装 runAgentStream 参数。 */
export class AgentRunner {
  private readonly stream: AgentStreamFunction;

  constructor(stream: AgentStreamFunction) {
    this.stream = stream;
  }

  run(request: AgentRunRequest): Promise<void> {
    return this.stream(
      request.port,
      request.payload,
      request.settings,
      request.book,
      request.signal,
      request.tabId,
      request.observeEvent
    );
  }
}

export function createAgentRunner(stream: AgentStreamFunction): AgentRunner {
  return new AgentRunner(stream);
}
