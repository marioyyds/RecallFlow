/**
 * 发布类站点的确定性安全门。
 *
 * JEV 不提供发布、发送等高危操作；这些动作由慢思考发起。这里在通用工具管线里
 * 再落一层站点级门禁，避免不同技能或不同提示词绕过同一条发布安全规则。
 */

export interface XhsCharacterEvidence {
  current: number;
  limit: number;
  overflowWarning: boolean;
  capturedAt: number;
  source: string;
}

export interface XhsHistoryEvidence {
  url: string;
  excerpt: string;
  capturedAt: number;
}

export interface PublicationEvidenceState {
  character?: XhsCharacterEvidence;
  history?: XhsHistoryEvidence;
}

export type PublicationGate =
  | { kind: 'none' }
  | {
      kind: 'block';
      action: 'generate-image' | 'publish';
      reason: string;
    }
  | {
      kind: 'confirm';
      action: 'publish';
      reason: string;
    };

const XHS_CREATOR_HOST = 'creator.xiaohongshu.com';
const PUBLISH_LABELS = new Set(['发布', '立即发布', '确认发布']);
const CHARACTER_LIMIT = 500;
const HISTORY_STATE = /(已发布|审核中|未通过)/;
const EMPTY_HISTORY = /(暂无笔记|暂无内容|没有笔记|还没有发布)/;
const OVERFLOW_WARNING = /最多\s*500\s*字|请删除后重试/;
const MUTATING_PAGE_TOOLS = new Set([
  'click_element',
  'click_at',
  'type_text',
  'press_key',
  'select_option',
  'check_box',
  'scroll_page',
  'drag_element',
  'upload_file',
  'run_javascript',
  'macro',
  'undo_last_action',
]);
const OBSERVATION_TOOLS = new Set([
  'read_current_page',
  'get_page_snapshot',
  'inspect_element',
  'get_ax_snapshot',
  'read_table',
]);

function normalizedText(value: unknown): string {
  return String(value || '').replace(/\r\n/g, '\n');
}

function safeUrl(value: unknown): URL | null {
  try {
    return new URL(String(value || ''));
  } catch {
    return null;
  }
}

function isXhsCreator(url: string): boolean {
  return safeUrl(url)?.hostname.toLowerCase() === XHS_CREATOR_HOST;
}

function isNoteManager(url: string): boolean {
  const parsed = safeUrl(url);
  return Boolean(
    parsed &&
      parsed.hostname.toLowerCase() === XHS_CREATOR_HOST &&
      /\/new\/note-manager(?:\/|$)/i.test(parsed.pathname)
  );
}

function isPublishEditor(url: string): boolean {
  const parsed = safeUrl(url);
  if (!parsed || parsed.hostname.toLowerCase() !== XHS_CREATOR_HOST) return false;
  if (/\/new\/note-manager(?:\/|$)/i.test(parsed.pathname)) return false;
  return (
    /\/new\/note(?:\/|$)/i.test(parsed.pathname) ||
    /\/publish\/publish(?:\/|$)/i.test(parsed.pathname)
  );
}

function resultText(result: any): string {
  const snapshotText = normalizedText(result?.pageSnapshot?.text || result?.snapshot?.text);
  const body = normalizedText(result?.result);
  return [snapshotText, body].filter(Boolean).join('\n');
}

function ctxText(ctx: any): string {
  return [
    normalizedText(ctx?.lastSnapshot?.text),
    normalizedText(ctx?.lastReadFullText),
    normalizedText(ctx?.lastEvidence),
  ].filter(Boolean).join('\n');
}

function targetLabel(name: string, args: Record<string, any>, ctx: any): string {
  if (name !== 'click_element') return '';
  const ref = String(args?.ref || '').trim();
  const selector = String(args?.selector || '').trim();
  const elements = Array.isArray(ctx?.lastSnapshot?.elements)
    ? ctx.lastSnapshot.elements
    : [];
  if (ref) {
    const match = elements.find((element: any) => String(element?.ref || '') === ref);
    if (match) {
      return String(match.label || match.name || match.placeholder || '').replace(/\s+/g, ' ').trim();
    }
  }
  if (selector) {
    const match = elements.find((element: any) => String(element?.selector || '') === selector);
    if (match) {
      return String(match.label || match.name || match.placeholder || '').replace(/\s+/g, ' ').trim();
    }
  }
  return String(args?.name || args?.text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 从页面上抓 500 字限制计数。只接受分母为 500 的计数，避免把页面里其他
 * “1 / 2”类比例误当成正文进度。
 */
export function parseXhsCharacterEvidence(text: unknown): {
  current: number;
  limit: number;
  overflowWarning: boolean;
} | null {
  const raw = normalizedText(text);
  const overflowWarning = OVERFLOW_WARNING.test(raw);
  let latest: { current: number; limit: number } | null = null;
  const pattern = /(\d{1,6})\s*\/\s*(\d{1,6})\s*(?:字|字符)?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw))) {
    const current = Number(match[1]);
    const limit = Number(match[2]);
    if (limit === CHARACTER_LIMIT && Number.isFinite(current)) {
      latest = { current, limit };
    }
  }
  return latest || overflowWarning
    ? {
        current: latest?.current ?? CHARACTER_LIMIT + 1,
        limit: latest?.limit ?? CHARACTER_LIMIT,
        overflowWarning,
      }
    : null;
}

function hasHistoryEvidence(text: unknown): boolean {
  const raw = normalizedText(text);
  if (EMPTY_HISTORY.test(raw)) return true;
  if (!HISTORY_STATE.test(raw)) return false;
  if (/(?:笔记)?标题\s*[:：]\s*\S{2,}/.test(raw)) return true;
  const lines = raw
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return lines.some(
    (line) =>
      line.length >= 4 &&
      line.length <= 120 &&
      !/^(笔记管理|全部|已发布|审核中|未通过|发布笔记|首页|数据|创作服务|新建笔记)$/.test(line)
  );
}

/**
 * 在工具执行后的统一后处理阶段调用。历史页证据跨页保留；字数证据在页面状态
 * 变化后若本轮快照没有再次给出计数，会失效并要求重新观察。
 */
export function captureXhsPublicationEvidence(
  ctx: any,
  toolName: string,
  beforeUrl: unknown,
  result: any
): void {
  const afterUrl = String(
    result?.pageSnapshot?.url ||
      result?.snapshot?.url ||
      ctx?.pageUrl ||
      beforeUrl ||
      ''
  );
  if (!isXhsCreator(afterUrl) && !isXhsCreator(String(beforeUrl || ''))) return;

  const state: PublicationEvidenceState =
    ctx.publicationEvidence && typeof ctx.publicationEvidence === 'object'
      ? ctx.publicationEvidence
      : {};
  const hasFreshSnapshot = Boolean(result?.pageSnapshot || result?.snapshot);
  const observedText = [
    resultText(result),
    hasFreshSnapshot ? '' : ctxText(ctx),
  ].filter(Boolean).join('\n');
  const character = parseXhsCharacterEvidence(observedText);
  if (character && isPublishEditor(afterUrl)) {
    state.character = {
      ...character,
      capturedAt: Date.now(),
      source: toolName,
    };
  } else if (MUTATING_PAGE_TOOLS.has(toolName) && isPublishEditor(afterUrl)) {
    delete state.character;
  }

  const historyUrl = isNoteManager(afterUrl)
    ? afterUrl
    : isNoteManager(String(beforeUrl || ''))
      ? String(beforeUrl || '')
      : '';
  if (historyUrl && OBSERVATION_TOOLS.has(toolName) && result?.ok !== false) {
    const text = [resultText(result), ctxText(ctx)].filter(Boolean).join('\n');
    if (hasHistoryEvidence(text)) {
      state.history = {
        url: historyUrl,
        excerpt: text.slice(0, 4000),
        capturedAt: Date.now(),
      };
    }
  }
  ctx.publicationEvidence = state;
}

function countBlockReason(character: XhsCharacterEvidence | undefined): string | null {
  if (!character) {
    return (
      '发布链路前置校验失败：未取得当前编辑器“正文字数 / 500 字”的最新页面证据。' +
      '请先调用 get_page_snapshot({maxText:4000}) 或 read_current_page 确认计数，再点击“生成图片”。' +
      '本次未执行，也未请求审批。'
    );
  }
  if (character.overflowWarning || character.current > character.limit) {
    return (
      '发布链路前置校验失败：小红书正文已超过 ' +
      character.limit +
      ' 字（当前 ' +
      character.current +
      ' 字）。请先删减到限额内并重新读取页面计数；本次未执行，也未请求审批。'
    );
  }
  return null;
}

function historyBlockReason(ctx: any): string | null {
  const history = ctx?.publicationEvidence?.history as XhsHistoryEvidence | undefined;
  if (
    history &&
    isNoteManager(history.url) &&
    hasHistoryEvidence(history.excerpt)
  ) {
    return null;
  }
  return (
    '发布链路前置校验失败：未检测到本任务对小红书“笔记管理”页（/new/note-manager）的有效读取证据。' +
    '请先读取该页，确认“已发布 / 审核中 / 未通过”状态及历史笔记标题（或确认列表为空），再返回编辑页发布。' +
    '仅看到侧栏“笔记管理”文字不算检查。本次未执行，也未请求审批。'
  );
}

/**
 * 每次 click_element 执行前调用。返回 confirm 时调用方必须走一次性审批，
 * 不允许站点信任、自动批准或会话级批准绕过。
 */
export function evaluateXhsPublicationGate(
  toolName: string,
  args: Record<string, any>,
  ctx: any
): PublicationGate {
  if (toolName !== 'click_element') return { kind: 'none' };
  const pageUrl = String(ctx?.pageUrl || ctx?.lastSnapshot?.url || '');
  if (!isXhsCreator(pageUrl) || !isPublishEditor(pageUrl)) return { kind: 'none' };

  const label = targetLabel(toolName, args || {}, ctx);
  const selector = String(args?.selector || '').toLowerCase();
  const testid = String(args?.testid || '').toLowerCase();
  const publishTarget =
    PUBLISH_LABELS.has(label) ||
    (!label && /publish(?:-|_)btn|publish-button/.test(selector + ' ' + testid));

  if (label === '生成图片') {
    const reason = countBlockReason(ctx?.publicationEvidence?.character);
    return reason
      ? { kind: 'block', action: 'generate-image', reason }
      : { kind: 'none' };
  }

  if (publishTarget) {
    const countReason = countBlockReason(ctx?.publicationEvidence?.character);
    if (countReason) return { kind: 'block', action: 'publish', reason: countReason };
    const historyReason = historyBlockReason(ctx);
    if (historyReason) return { kind: 'block', action: 'publish', reason: historyReason };
    return {
      kind: 'confirm',
      action: 'publish',
      reason: '发布是不可逆的外部操作，必须在完成字数与历史笔记检查后由用户最终确认。',
    };
  }

  return { kind: 'none' };
}
