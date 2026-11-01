// TypeSafe System One protocol types and runtime validation.
//
// TypeSafe answers named questions about a state. It is not a chat model:
// there is no assistant text or tool call in the response. RecallFlow converts
// validated answers into its own typed fast-path decision.

export const JEV_PROTOCOL_VERSION = 'jev.recallflow.v1';

export type JevInstruction = string | Record<string, unknown> | unknown[];

export interface JevNoulQuestion {
  type: 'noul';
  instructions?: JevInstruction | null;
  criteria?: {
    true?: JevInstruction | null;
    false?: JevInstruction | null;
  } | null;
}

export interface JevChoiceQuestion {
  type: 'choice';
  instructions?: JevInstruction | null;
  criteria: Record<string, JevInstruction | null>;
}

export interface JevScoreQuestion {
  type: 'score';
  instructions?: JevInstruction | null;
  criteria: JevInstruction[];
}

export interface JevBoxQuestion {
  type: 'box';
  instructions?: JevInstruction | null;
}

export type JevQuestion =
  | JevNoulQuestion
  | JevChoiceQuestion
  | JevScoreQuestion
  | JevBoxQuestion;

export interface JevAsset {
  type: 'image';
  format: 'png' | 'jpg' | 'jpeg';
  data_base64?: string;
  part?: string;
}

export interface JevSystemOneRequest {
  model: string;
  state: string | Record<string, unknown> | unknown[];
  questions: Record<string, JevQuestion>;
  assets?: Record<string, JevAsset>;
}

export interface JevNoulAnswer {
  type: 'noul';
  noul: number;
}

export interface JevChoiceAnswer {
  type: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface JevScoreAnswer {
  type: 'score';
  score: number;
  confidence: number;
  legend: Record<string, JevInstruction>;
  probabilities: Record<string, number>;
}

export interface JevBoxAnswer {
  type: 'box';
  box: {
    top: number;
    bottom: number;
    left: number;
    right: number;
  };
  confidence: number | null;
}

export type JevAnswer =
  | JevNoulAnswer
  | JevChoiceAnswer
  | JevScoreAnswer
  | JevBoxAnswer;

export interface JevUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface JevSystemOneResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: JevUsage;
}

export interface JevModelMetadata {
  name: string;
  description: string;
  release_date: string;
}

export interface JevModelList {
  models: JevModelMetadata[];
}

export class JevProtocolError extends Error {
  readonly path: string;

  constructor(message: string, path = '') {
    super(message);
    this.name = 'JevProtocolError';
    this.path = path;
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new JevProtocolError('必须是对象', path);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new JevProtocolError('必须是非空字符串', path);
  }
  return value;
}

function count(value: unknown, path: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new JevProtocolError('必须是非负整数', path);
  }
  return Number(value);
}

function probability(value: unknown, path: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new JevProtocolError('必须是 0 到 1 之间的数字', path);
  }
  return n;
}

function numericMap(value: unknown, path: string): Record<string, number> {
  const source = record(value, path);
  const result: Record<string, number> = {};
  for (const [key, item] of Object.entries(source)) {
    result[key] = probability(item, path + '.' + key);
  }
  return result;
}

function protocolText(value: unknown, path: string): JevInstruction {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value;
  return record(value, path);
}

function parseLegend(value: unknown, path: string): Record<string, JevInstruction> {
  const source = record(value, path);
  const result: Record<string, JevInstruction> = {};
  for (const [key, item] of Object.entries(source)) {
    result[key] = protocolText(item, path + '.' + key);
  }
  return result;
}

export function parseJevAnswer(value: unknown, path = 'answer'): JevAnswer {
  const source = record(value, path);
  const type = text(source.type, path + '.type');
  if (type === 'noul') {
    return { type, noul: probability(source.noul, path + '.noul') };
  }
  if (type === 'choice') {
    return {
      type,
      choice: text(source.choice, path + '.choice'),
      confidence: probability(source.confidence, path + '.confidence'),
      probabilities: numericMap(source.probabilities, path + '.probabilities'),
    };
  }
  if (type === 'score') {
    const score = Number(source.score);
    if (!Number.isFinite(score)) {
      throw new JevProtocolError('必须是有限数字', path + '.score');
    }
    return {
      type,
      score,
      confidence: probability(source.confidence, path + '.confidence'),
      legend: parseLegend(source.legend, path + '.legend'),
      probabilities: numericMap(source.probabilities, path + '.probabilities'),
    };
  }
  if (type === 'box') {
    const box = record(source.box, path + '.box');
    const confidence = source.confidence === null
      ? null
      : probability(source.confidence, path + '.confidence');
    return {
      type,
      box: {
        top: probability(box.top, path + '.box.top'),
        bottom: probability(box.bottom, path + '.box.bottom'),
        left: probability(box.left, path + '.box.left'),
        right: probability(box.right, path + '.box.right'),
      },
      confidence,
    };
  }
  throw new JevProtocolError('未知答案类型：' + type, path + '.type');
}

function expectedAnswerType(question: JevQuestion): JevAnswer['type'] {
  return question.type;
}

export function parseJevSystemOneResponse(
  value: unknown,
  questions?: Record<string, JevQuestion>
): JevSystemOneResponse {
  const source = record(value, 'response');
  const answerSource = record(source.answers, 'response.answers');
  const answers: Record<string, JevAnswer> = {};
  for (const [name, answerValue] of Object.entries(answerSource)) {
    const answer = parseJevAnswer(answerValue, 'response.answers.' + name);
    const question = questions && questions[name];
    if (question && answer.type !== expectedAnswerType(question)) {
      throw new JevProtocolError(
        '答案类型 ' + answer.type + ' 与问题类型 ' + question.type + ' 不匹配',
        'response.answers.' + name
      );
    }
    answers[name] = answer;
  }
  if (questions) {
    const missing = Object.keys(questions).filter((name) => !answers[name]);
    if (missing.length) {
      throw new JevProtocolError(
        '缺少问题答案：' + missing.join('、'),
        'response.answers'
      );
    }
  }
  const usage = record(source.usage, 'response.usage');
  return {
    model: text(source.model, 'response.model'),
    answers,
    usage: {
      input_tokens: count(usage.input_tokens, 'response.usage.input_tokens'),
      output_tokens: count(usage.output_tokens, 'response.usage.output_tokens'),
    },
  };
}

export function parseJevModelList(value: unknown): JevModelList {
  const source = record(value, 'response');
  if (!Array.isArray(source.models)) {
    throw new JevProtocolError('必须是数组', 'response.models');
  }
  return {
    models: source.models.map((item, index) => {
      const model = record(item, 'response.models.' + index);
      return {
        name: text(model.name, 'response.models.' + index + '.name'),
        description: String(model.description || ''),
        release_date: String(model.release_date || ''),
      };
    }),
  };
}
