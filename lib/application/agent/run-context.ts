import type { KnowledgeBook } from '../../shared/store.ts';
import type { AgentBudget, AgentSettings, McpServerStatus, PlanStep, RunCtx, TraceStep } from './types.ts';

export interface AgentRunContextInput {
  book: KnowledgeBook;
  settings: AgentSettings;
  budget: AgentBudget;
  browserMode: boolean;
  canResume: boolean;
  tabId?: number;
  payload: Record<string, any>;
  persisted: Record<string, any> | null | undefined;
}

function arrayCopy<T>(value: unknown): T[] {
  return Array.isArray(value) ? value.slice() as T[] : [];
}

function finiteInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

/**
 * 构造一次 Agent run 的显式上下文。
 *
 * 新任务只读取本次 payload；恢复任务优先使用已经落盘的页面、标签页、计划和轨迹。
 * 把这条分叉放在纯工厂里，避免主循环一边初始化状态、一边继续追加 `any` 字段。
 */
export function createAgentRunContext(input: AgentRunContextInput): RunCtx {
  const payload = input.payload || {};
  const persisted = input.persisted || {};
  const resumed = input.canResume === true;

  return {
    book: input.book,
    settings: input.settings,
    sessionId: String(payload.sessionId || ''),
    page: resumed ? String(persisted.page || '') : String(payload.page || ''),
    pageUrl: resumed ? String(persisted.pageUrl || '') : String(payload.pageUrl || ''),
    pageTitle: resumed ? String(persisted.pageTitle || '') : String(payload.pageTitle || ''),
    tabId: (input.tabId || (resumed ? persisted.tabId : undefined)) as number,
    originalTabId: resumed
      ? Number(persisted.originalTabId || input.tabId)
      : input.tabId,
    openedTabs: resumed ? arrayCopy<number>(persisted.openedTabs) : [],
    openedTabCount: resumed ? Number(persisted.openedTabCount || 0) : 0,
    maxOpenedTabs: input.budget.maxOpenedTabs || 0,
    tabSwitchCount: resumed ? Number(persisted.tabSwitchCount || 0) : 0,
    maxTabSwitches: input.budget.maxTabSwitches || 0,
    failedUrls: resumed ? arrayCopy<string>(persisted.failedUrls) : [],
    browsingMode: input.browserMode ? 'shared' : 'isolated',
    agentWindowId: resumed ? finiteInteger(persisted.agentWindowId) : null,
    trace: resumed ? arrayCopy<TraceStep>(persisted.trace) : [],
    plan: resumed ? arrayCopy<PlanStep>(persisted.plan) : [],
    resultStore: new Map<string, string>(),
    resultIds: new Set<string>(resumed ? arrayCopy<string>(persisted.resultIds) : []),
    lastSnapshot: null,
    lastEvidence: '',
    lastReadFullText: '',
    mcpIndex: new Map(),
    mcpStatus: [] as McpServerStatus[],
  };
}
