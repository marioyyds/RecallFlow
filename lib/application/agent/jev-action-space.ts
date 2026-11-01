import type { JevSettings } from '../../shared/settings.ts';
import { JEV_PROTOCOL_VERSION, type JevSystemOneRequest, type JevSystemOneResponse } from './jev-contract.ts';

export const JEV_NEXT_ACTION_QUESTION = 'next_action';
export const JEV_MIN_ACTION_CONFIDENCE = 0.72;

export type JevReadToolName = 'read_current_page' | 'read_table';

export interface JevReadAction {
  kind: 'act';
  toolName: JevReadToolName;
  args: Record<string, unknown>;
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
  instruction: string;
  selectedText?: string;
  pageUrl?: string;
  pageTitle?: string;
  pageText?: string;
  recentTools?: string[];
}

const READ_ACTIONS: Record<JevReadToolName, { args: Record<string, unknown>; description: string }> = {
  read_current_page: {
    args: {},
    description: '当前页面的可见正文不完整、需要读取全文后再回答或继续操作',
  },
  read_table: {
    args: {},
    description: '任务需要读取页面中的结构化表格、网格、统计行或分页数据',
  },
};

function clip(value: unknown, maxChars: number): string {
  const text = String(value || '');
  return text.length > maxChars ? text.slice(0, maxChars) + '\n…' : text;
}

export function buildJevFastRequest(
  settings: Pick<JevSettings, 'model'>,
  context: JevFastContext
): JevSystemOneRequest {
  const criteria: Record<string, string> = {};
  for (const [name, action] of Object.entries(READ_ACTIONS)) {
    criteria[name] = action.description;
  }
  criteria.escalate =
    '目标有歧义、需要多步规划、需要修改页面或知识库、需要聊天模型生成最终回答，或当前信息不足且读取动作无法安全解决';

  return {
    model: settings.model,
    state: {
      protocol: JEV_PROTOCOL_VERSION,
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
      recentTools: (context.recentTools || []).slice(-8),
    },
    questions: {
      [JEV_NEXT_ACTION_QUESTION]: {
        type: 'choice',
        instructions:
          '选择执行一个只读动作是否能直接帮助当前任务。不要规划写操作、点击、输入或最终回答；这些情况选择 escalate。',
        criteria,
      },
    },
  };
}

export function interpretJevFastDecision(response: JevSystemOneResponse): JevFastDecision {
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
  if (!(answer.choice in READ_ACTIONS)) {
    return {
      kind: 'escalate',
      reason: 'unknown-action',
      choice: answer.choice,
      confidence: answer.confidence,
    };
  }
  if (answer.confidence < JEV_MIN_ACTION_CONFIDENCE) {
    return {
      kind: 'escalate',
      reason: 'low-confidence',
      choice: answer.choice,
      confidence: answer.confidence,
    };
  }
  const toolName = answer.choice as JevReadToolName;
  return {
    kind: 'act',
    toolName,
    args: { ...READ_ACTIONS[toolName].args },
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
