import type { JevSettings } from '../../shared/settings.ts';
import { JEV_PROTOCOL_VERSION, type JevSystemOneRequest, type JevSystemOneResponse } from './jev-contract.ts';
import type { PageSnapshotLike } from './types.ts';

export const JEV_NEXT_ACTION_QUESTION = 'next_action';
export const JEV_MIN_ACTION_CONFIDENCE = 0.72;
export const JEV_MIN_CLICK_CONFIDENCE = 0.86;
export const JEV_MAX_ELEMENT_ACTIONS = 10;

export type JevToolName =
  | 'read_current_page'
  | 'read_table'
  | 'get_page_snapshot'
  | 'get_ax_snapshot'
  | 'scroll_page'
  | 'click_element';

export interface JevActionDefinition {
  key: string;
  toolName: JevToolName;
  args: Record<string, unknown>;
  description: string;
  minConfidence: number;
}

export interface JevFastRequestBundle {
  request: JevSystemOneRequest;
  actions: Record<string, JevActionDefinition>;
}

export interface JevReadAction {
  kind: 'act';
  actionKey: string;
  toolName: JevToolName;
  args: Record<string, unknown>;
  description: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export type JevFastDecision =
  | JevReadAction
  | {
      kind: 'escalate';
      reason:
        | 'model-escalation'
        | 'low-confidence'
        | 'unknown-action'
        | 'invalid-answer';
      choice?: string;
      confidence?: number;
    };

export interface JevFastContext {
  intent: string;
  phase: string;
  instruction: string;
  selectedText?: string;
  pageUrl?: string;
  pageTitle?: string;
  pageText?: string;
  snapshot?: PageSnapshotLike | null;
  recentTools?: string[];
}

const BASE_ACTIONS: JevActionDefinition[] = [
  {
    key: 'read_page',
    toolName: 'read_current_page',
    args: {},
    description: '当前页面的可见正文不完整、需要读取全文后再回答或继续操作',
    minConfidence: JEV_MIN_ACTION_CONFIDENCE,
  },
  {
    key: 'read_table',
    toolName: 'read_table',
    args: {},
    description: '任务需要读取页面中的结构化表格、网格、统计行或分页数据',
    minConfidence: JEV_MIN_ACTION_CONFIDENCE,
  },
  {
    key: 'snapshot',
    toolName: 'get_page_snapshot',
    args: { maxText: 1200 },
    description: '需要最新 DOM 结构与可见交互元素，尤其适合页面刚变化或缺少可用 ref 时',
    minConfidence: JEV_MIN_ACTION_CONFIDENCE,
  },
  {
    key: 'accessibility',
    toolName: 'get_ax_snapshot',
    args: { limit: 40 },
    description: 'DOM 定位失败、自定义组件或需要 role/name/坐标时读取可访问性树',
    minConfidence: JEV_MIN_ACTION_CONFIDENCE,
  },
  {
    key: 'scroll_down',
    toolName: 'scroll_page',
    args: { y: 600 },
    description: '目标可能在当前视口下方，并且读取当前结构后仍缺少内容时向下滚动',
    minConfidence: JEV_MIN_ACTION_CONFIDENCE,
  },
];

const RISKY_CLICK_LABEL = /(删除|移除|清空|退出|注销|取消|支付|购买|提交|发布|发送|关闭|卸载|重置)/i;
const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea']);
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'tab',
  'menuitem',
  'option',
]);

function clip(value: unknown, maxChars: number): string {
  const text = String(value || '');
  return text.length > maxChars ? text.slice(0, maxChars) + '\n…' : text;
}

export function deriveJevPhase(
  pageUrl: unknown,
  pageTitle: unknown,
  snapshot?: PageSnapshotLike | null
): string {
  const haystack = String(pageUrl || '') + ' ' + String(pageTitle || '');
  if (/(publish\/success|success|发布成功|完成发布)/i.test(haystack)) return 'verification';
  if (
    /(editor|publish|creator|创作|编辑|发布)/i.test(haystack) ||
    Number(snapshot?.capabilities?.editables?.count || 0) > 0
  ) {
    return 'editor';
  }
  if (/(github|arxiv|docs?|paper|research|论文|文档)/i.test(haystack)) return 'research';
  return 'browsing';
}

function elementActions(snapshot?: PageSnapshotLike | null): JevActionDefinition[] {
  const elements = Array.isArray(snapshot?.elements) ? snapshot.elements : [];
  const actions: JevActionDefinition[] = [];
  for (const element of elements) {
    if (actions.length >= JEV_MAX_ELEMENT_ACTIONS) break;
    if (element.disabled === true || element.inViewport === false) continue;
    const tag = String(element.tag || '').toLowerCase();
    const role = String(element.role || '').toLowerCase();
    if (!INTERACTIVE_TAGS.has(tag) && !INTERACTIVE_ROLES.has(role)) continue;
    const label = String(
      element.label || element.name || element.text || element.placeholder || ''
    ).replace(/\s+/g, ' ').trim();
    const identity = [label, tag, role, element.selector, element.testid].filter(Boolean).join(' ');
    if (!label || RISKY_CLICK_LABEL.test(identity)) continue;
    const target = element.ref || element.selector;
    if (!target) continue;
    const args: Record<string, unknown> = element.ref
      ? { ref: element.ref }
      : { selector: element.selector };
    actions.push({
      key: 'click_' + actions.length,
      toolName: 'click_element',
      args,
      description:
        '点击当前可见元素「' + clip(label, 100) + '」（' +
        (role || tag || 'interactive') + '）；仅在它直接推进当前目标时选择',
      minConfidence: JEV_MIN_CLICK_CONFIDENCE,
    });
  }
  return actions;
}

export function buildJevFastRequest(
  settings: Pick<JevSettings, 'model'>,
  context: JevFastContext
): JevFastRequestBundle {
  const actionList = [...BASE_ACTIONS, ...elementActions(context.snapshot)];
  const actions = Object.fromEntries(actionList.map((action) => [action.key, action]));
  const criteria: Record<string, string> = {};
  for (const action of actionList) {
    criteria[action.key] = action.description;
  }
  criteria.escalate =
    '目标有歧义、需要生成或编辑实质内容、需要高风险写操作、当前候选都不可靠，或需要聊天模型重新规划';

  const request: JevSystemOneRequest = {
    model: settings.model,
    state: {
      protocol: JEV_PROTOCOL_VERSION,
      phase: context.phase,
      task: {
        intent: context.intent,
        instruction: clip(context.instruction, 4000),
        selectedText: clip(context.selectedText, 4000),
      },
      page: {
        url: clip(context.pageUrl, 2000),
        title: clip(context.pageTitle, 500),
        visibleText: clip(context.pageText, 12000),
      },
      observation: context.snapshot ? {
        fingerprint: clip(context.snapshot.fingerprint, 200),
        elements: elementActions(context.snapshot).map((action) => ({
          key: action.key,
          tool: action.toolName,
          args: action.args,
          label: action.description,
        })),
        capabilities: context.snapshot.capabilities || {},
      } : null,
      recentTools: (context.recentTools || []).slice(-8),
    },
    questions: {
      [JEV_NEXT_ACTION_QUESTION]: {
        type: 'choice',
        instructions:
          '选择当前最能推动任务的一项局部动作。优先观察或安全点击；发布、发送、删除、支付、内容生成和最终回答必须 escalate。',
        criteria,
      },
    },
  };
  return { request, actions };
}

export function interpretJevFastDecision(
  response: JevSystemOneResponse,
  actions: Record<string, JevActionDefinition>
): JevFastDecision {
  const answer = response.answers[JEV_NEXT_ACTION_QUESTION];
  if (!answer || answer.type !== 'choice') {
    return { kind: 'escalate', reason: 'invalid-answer' };
  }
  if (answer.choice === 'escalate') {
    return {
      kind: 'escalate',
      reason: 'model-escalation',
      choice: answer.choice,
      confidence: answer.confidence,
    };
  }
  const action = actions[answer.choice];
  if (!action) {
    return {
      kind: 'escalate',
      reason: 'unknown-action',
      choice: answer.choice,
      confidence: answer.confidence,
    };
  }
  if (answer.confidence < action.minConfidence) {
    return {
      kind: 'escalate',
      reason: 'low-confidence',
      choice: answer.choice,
      confidence: answer.confidence,
    };
  }
  return {
    kind: 'act',
    actionKey: action.key,
    toolName: action.toolName,
    args: { ...action.args },
    description: action.description,
    confidence: answer.confidence,
    probabilities: { ...answer.probabilities },
  };
}

export function compareJevShadowAction(
  suggestion: JevFastDecision,
  slowToolNames: string[],
  finalText = ''
) {
  const names = Array.isArray(slowToolNames) ? slowToolNames.filter(Boolean) : [];
  const suggestedTool = suggestion.kind === 'act' ? suggestion.toolName : 'escalate';
  return {
    suggestedTool,
    slowTools: names,
    agreed: suggestion.kind === 'act'
      ? names.includes(suggestion.toolName)
      : names.length === 0 && Boolean(String(finalText || '').trim()),
    finalAnswerOnly: names.length === 0 && Boolean(String(finalText || '').trim()),
  };
}
