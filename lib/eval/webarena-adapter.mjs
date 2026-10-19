// WebArena 适配层（纯逻辑、零依赖，node 可直接 import 做单测）。
//
// 它存在的理由：WebArena-Verified 要求 agent 交回一个**结构化最终答复**
// （FinalAgentResponse：task_type / status / retrieved_data / error_details），
// 而 RecallFlow 的 agent 交回的是自然语言答复。两者之间必须有一层可测的翻译，
// 否则两头都会**静默**出错：
//   · 契约没写进指令 → 模型给自由文本 → 解析失败 → 整条任务被误判成 UNKNOWN_ERROR；
//   · 解析太宽松 → 把一句像样的自然语言认成结构化结果 → **假成功**（比失败更糟）。
// 所以这里把「构造指令」「解析答复」「校验 schema」都做成有断言的纯函数。
//
// 字段名坑（照抄官方文档会踩）：文档散文表用 action/results，
// 而 Python 数据模型与 expected 示例用 task_type/retrieved_data。
// 本模块**产出**规范键（task_type/retrieved_data），**接受**两种别名。

/**
 * 三种动作类型。大小写不敏感地归一化为小写 —— 官方 JSON 示例是小写
 * （"task_type": "retrieve"），但 Python 类型名是 RETRIEVE，两者都会出现在真实数据里。
 */
export const TASK_TYPES = Object.freeze(['retrieve', 'mutate', 'navigate']);

/** 允许的终态码（见官方 Agent Response Schema）。 */
export const FINAL_STATUS = Object.freeze([
  'SUCCESS',
  'NOT_FOUND_ERROR',
  'ACTION_NOT_ALLOWED_ERROR',
  'PERMISSION_DENIED_ERROR',
  'DATA_VALIDATION_ERROR',
  'UNKNOWN_ERROR',
]);

/** 常见别名 → 规范状态码。作用是把模型的口语写法收敛，而不是放过它。 */
const STATUS_ALIASES = Object.freeze({
  ok: 'SUCCESS',
  success: 'SUCCESS',
  succeeded: 'SUCCESS',
  done: 'SUCCESS',
  completed: 'SUCCESS',
  not_found: 'NOT_FOUND_ERROR',
  notfound: 'NOT_FOUND_ERROR',
  not_found_error: 'NOT_FOUND_ERROR',
  not_allowed: 'ACTION_NOT_ALLOWED_ERROR',
  action_not_allowed_error: 'ACTION_NOT_ALLOWED_ERROR',
  permission_denied: 'PERMISSION_DENIED_ERROR',
  permission_denied_error: 'PERMISSION_DENIED_ERROR',
  data_validation_error: 'DATA_VALIDATION_ERROR',
  invalid_input: 'DATA_VALIDATION_ERROR',
  unknown_error: 'UNKNOWN_ERROR',
  error: 'UNKNOWN_ERROR',
  failed: 'UNKNOWN_ERROR',
});

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function asNonEmptyString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 从一条 WebArena-Verified 任务的 eval[] 里读出期望动作（小写）。找不到返回 ''。 */
export function expectedActionOf(raw) {
  const evals = toArray(raw && raw.eval);
  for (const item of evals) {
    const expected = item && item.expected;
    const action = asNonEmptyString(expected && (expected.task_type || expected.action));
    if (action) {
      const norm = action.toLowerCase();
      if (TASK_TYPES.includes(norm)) return norm;
    }
  }
  return '';
}

/**
 * 校验并归一化一条 WebArena-Verified 任务。
 *
 * 严格之处：缺 intent / 缺 task_id / 未知动作一律抛错，且错误里点名缺了什么 ——
 * 一条任务配置写错时，最坏的结果是**静默跑成 UNKNOWN_ERROR**，
 * 那会把"配置错了"记成"模型不行"。
 *
 * @returns {{taskId:number, sites:string[], startUrls:string[], intent:string, expectedAction:string}}
 */
export function normalizeTask(raw) {
  const t = raw || {};
  const taskId = Number(t.task_id !== undefined ? t.task_id : t.taskId);
  if (!Number.isInteger(taskId) || taskId < 0) {
    throw new Error('任务缺少合法的 task_id（收到：' + JSON.stringify(t.task_id !== undefined ? t.task_id : t.taskId) + '）');
  }
  const intent = asNonEmptyString(t.intent);
  if (!intent) throw new Error('任务 ' + taskId + ' 缺少 intent（要做什么的自然语言描述）');
  const startUrls = toArray(t.start_urls !== undefined ? t.start_urls : t.startUrls)
    .map((u) => asNonEmptyString(u))
    .filter(Boolean);
  if (startUrls.length === 0) throw new Error('任务 ' + taskId + ' 缺少 start_urls（起始页）');
  const expectedAction = expectedActionOf(t);
  if (!expectedAction) {
    throw new Error(
      '任务 ' + taskId + ' 的 eval[] 里读不到期望动作（retrieve/mutate/navigate）。' +
        '没它就构造不出终态契约，模型会凭感觉给答复。'
    );
  }
  return {
    taskId,
    sites: toArray(t.sites).map((s) => String(s)),
    startUrls,
    intent,
    expectedAction,
  };
}

/**
 * 构造发给 RecallFlow `agent_task` 的指令。
 *
 * 三个必要成分，缺一不可（这是本适配层最容易出错的地方）：
 *   ① 任务原文 intent —— 不能替模型改写，否则评的就不是同一道题；
 *   ② 起始页 —— 否则模型面对的是"当前那个标签页"，结果不可复现；
 *   ③ **终态契约** —— 明确要求它在答复最后吐一个 JSON 块，并列出状态码与 results 规则。
 */
export function buildInstruction(task, opts = {}) {
  const t = task && task.intent ? task : normalizeTask(task);
  const startUrl = asNonEmptyString(opts.startUrl) || t.startUrls[0] || '';
  const action = t.expectedAction;
  const placeholder =
    action === 'retrieve' ? { task_type: 'retrieve', status: 'SUCCESS', retrieved_data: [] } :
    { task_type: action, status: 'SUCCESS', retrieved_data: null };
  const lines = [
    '你正在一个真实浏览器里完成一个网页任务。请用工具在页面上真正完成它，不要只回答问题，也不要向用户请求确认。',
    '',
    '起始页：' + startUrl,
    '任务：' + t.intent,
    '',
    '全部完成后，在你的答复**最后**给出一个 JSON 代码块（```json），字段严格如下：',
    '```json',
    JSON.stringify(placeholder, null, 2),
    '```',
    '规则：',
    '· task_type 必须是 retrieve / mutate / navigate 之一（本任务期望：' + action + '）。',
    '· status 只能是 ' + FINAL_STATUS.join(' / ') + '；失败时把原因写进 error_details。',
    '· task_type 为 retrieve 且成功时，retrieved_data 是数组，且数组项**类型一致**（要么同类型基本值，要么是键集合完全相同的对象）；查不到就返回空数组并把 status 置为 NOT_FOUND_ERROR。',
    '· task_type 为 mutate / navigate 时，retrieved_data 必须是 null。',
    '· 成功时不要写 error_details。',
  ];
  return lines.join('\n');
}

function tryParseJson(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch (e) {
    return null;
  }
}

/** 从 `start`（必须是 `{`）开始，跳过字符串与转义，找到配对的 `}` 下标；找不到返回 -1。 */
function matchBrace(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 一个对象是否"看起来是"结构化答复（有 task_type 或 action）。 */
function looksLikeResponse(obj) {
  return Boolean(obj && (asNonEmptyString(obj.task_type) || asNonEmptyString(obj.action)));
}

/**
 * 从模型答复里抽出结构化 JSON 块。优先取**最后一个**能解析的 ```json 围栏；
 * 没有围栏时，从后往前找第一个能解析且带 task_type/action 的平衡花括号对象。
 *
 * 为什么取最后一个：模型常在正文里举例、再在结尾给真正的结论。
 * 取第一个会把示例当结论（这是真实会发生的误判，不是杞人忧天）。
 *
 * @returns {object|null}
 */
export function extractFinalJson(text) {
  const s = String(text || '');
  const fences = [...s.matchAll(/```[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi)];
  for (let i = fences.length - 1; i >= 0; i--) {
    const obj = tryParseJson(fences[i][1]);
    if (looksLikeResponse(obj)) return obj;
  }
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] !== '{') continue;
    const end = matchBrace(s, i);
    if (end < 0) continue;
    const obj = tryParseJson(s.slice(i, end + 1));
    if (looksLikeResponse(obj)) return obj;
  }
  return null;
}

function statusName(raw) {
  const s = asNonEmptyString(raw);
  if (!s) return '';
  const upper = s.toUpperCase();
  if (FINAL_STATUS.includes(upper)) return upper;
  const alias = STATUS_ALIASES[s.toLowerCase()];
  return alias || '';
}

/**
 * 把一个（可能来自模型的）结构化对象归一化成规范 FinalAgentResponse。
 *
 * **不**替模型猜：读不出动作类型或状态就报错，交由调用方决定降级为 UNKNOWN_ERROR。
 * 静默补一个看似合理的默认值，正是"假成功"的来源。
 *
 * @returns {{ok:true,value:object}|{ok:false,error:string}}
 */
export function normalizeAgentResponse(raw, opts = {}) {
  const fallbackAction = asNonEmptyString(opts.fallbackAction).toLowerCase();
  if (!raw || typeof raw !== 'object') return { ok: false, error: '答复不是对象' };
  let action = asNonEmptyString(raw.task_type || raw.action).toLowerCase();
  if (!action) action = fallbackAction;
  if (!TASK_TYPES.includes(action)) {
    return { ok: false, error: '读不出合法的 task_type/action（收到：' + JSON.stringify(raw.task_type || raw.action) + '）' };
  }
  const status = statusName(raw.status);
  if (!status) {
    return { ok: false, error: '读不出合法的 status（收到：' + JSON.stringify(raw.status) + '）' };
  }
  const dataRaw = raw.retrieved_data !== undefined ? raw.retrieved_data : raw.results;
  let retrievedData = null;
  if (Array.isArray(dataRaw)) retrievedData = dataRaw;
  else if (dataRaw === undefined || dataRaw === null) retrievedData = null;
  else return { ok: false, error: 'retrieved_data/results 必须是数组或 null（收到：' + typeof dataRaw + '）' };

  const value = { task_type: action, status, retrieved_data: retrievedData };
  const detail = asNonEmptyString(raw.error_details);
  if (detail) value.error_details = detail;
  else value.error_details = null;
  return { ok: true, value };
}

function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** 校验 results 的同质性：要么全是同类型基本值，要么是键集合完全相同的对象。返回错误串或 null。 */
function homogeneousError(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const first = typeName(items[0]);
  for (const it of items) {
    if (typeName(it) !== first) return 'retrieved_data 项类型不一致：' + first + ' 与 ' + typeName(it);
  }
  if (first === 'object') {
    const key = Object.keys(items[0]).sort().join(',');
    for (const it of items) {
      if (Object.keys(it).sort().join(',') !== key) return 'retrieved_data 中对象的键集合不一致';
    }
  }
  return null;
}

/**
 * 按官方 schema 校验一条 FinalAgentResponse。返回 `{ok, errors:string[]}`。
 * 覆盖：动作/状态合法性、retrieve 成功必须有数组、非 retrieve 必须 null/[]、成功不得带 error_details、results 同质性。
 */
export function validateAgentResponse(resp) {
  const errors = [];
  const r = resp || {};
  if (!TASK_TYPES.includes(r.task_type)) errors.push('task_type 非法：' + JSON.stringify(r.task_type));
  if (!FINAL_STATUS.includes(r.status)) errors.push('status 非法：' + JSON.stringify(r.status));
  const data = r.retrieved_data;
  if (r.task_type === 'retrieve' && r.status === 'SUCCESS') {
    if (!Array.isArray(data)) errors.push('retrieve+SUCCESS 的 retrieved_data 必须是数组');
  } else if (r.task_type !== 'retrieve') {
    if (!(data === null || data === undefined || (Array.isArray(data) && data.length === 0))) {
      errors.push('非 retrieve 任务的 retrieved_data 必须是 null 或空数组');
    }
  }
  if (r.status === 'SUCCESS' && r.error_details) errors.push('status 为 SUCCESS 时不应有 error_details');
  if (r.status !== 'SUCCESS' && !r.error_details) errors.push('非 SUCCESS 状态应给出 error_details');
  const hom = homogeneousError(Array.isArray(data) ? data : null);
  if (hom) errors.push(hom);
  return { ok: errors.length === 0, errors };
}

/** 终态（非 running）的 job 状态 → 失败答复。用于把"没跑完"如实记成失败而不是丢空。 */
export function failureResponse(state, detail) {
  const body = 'agent 任务未成功结束（state=' + state + '）' + (detail ? '：' + detail : '');
  return { task_type: 'retrieve', status: 'UNKNOWN_ERROR', retrieved_data: null, error_details: body };
}

/**
 * 把「RecallFlow job 终态 + agent 最终答复」映射成 FinalAgentResponse。
 *
 * 映射规则（宁可为失败，不伪造成功）：
 *   · job 未成功结束（failed / stalled / cancelled / running）→ UNKNOWN_ERROR，并带上 job 的错误；
 *   · 答复里抽不到结构化 JSON → UNKNOWN_ERROR（**不**挽尊成"看起来像成功"）；
 *   · 抽到但字段非法 → UNKNOWN_ERROR，并把具体原因写进 error_details。
 */
export function toAgentResponse(answer, opts = {}) {
  const state = asNonEmptyString(opts.state);
  if (state && state !== 'completed') {
    return failureResponse(state, asNonEmptyString(opts.error));
  }
  const raw = extractFinalJson(answer);
  if (!raw) {
    return failureResponse('no-structured-answer', '答复里没有可解析的 JSON 终态块（模型没按契约回答？）');
  }
  const norm = normalizeAgentResponse(raw, { fallbackAction: opts.expectedAction });
  if (!norm.ok) return failureResponse('invalid-structured-answer', norm.error);
  const check = validateAgentResponse(norm.value);
  if (!check.ok) return failureResponse('schema-violation', check.errors.join('；'));
  return norm.value;
}
