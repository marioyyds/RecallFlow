// Pure completion-verification and liveness policies.
import { getToolMetadata, compactSnapshotSummary } from '../../assistant/tools.ts';
import { INTENTS } from '../../assistant/intent-router.ts';
import { selectEvidence } from '../../assistant/evidence.ts';
import { sliceSafe } from '../../shared/surrogates.ts';

export const EVIDENCE_READ_TOOLS = new Set([
  'read_current_page',
  'get_page_snapshot',
  'inspect_element',
  'get_ax_snapshot',
  'expand_result',
  'fetch_webpage',
]);

const EVIDENCE_RECEIPT_CHARS = 1800;

function changesState(md: any) {
  if (!md) return true;
  return md.readOnly !== true && md.mutatesState !== false;
}

/**
 * 存活看门狗（纯函数，便于直测边界语义）。
 *
 * 判定「本任务是否已经不再产生任何可观察进展」。它与 token 成本闸门是**互补**的：
 * 成本闸门管"花了多少钱"，它管"是不是卡住了" —— 一个卡住的任务可能几轮就烧掉大量 token，
 * 也可能因为每轮都很小而烧得慢却永远不回结果。
 *
 * 语义：
 *   - 尚未有过任何进展（lastProgressIter 为 null）时，以起点为基准，不会一开工就判定卡死；
 *   - 只要有过进展就重置基准，**正常的长任务永远不会触发**（这是它不构成"进度墙"的关键）；
 *   - maxNoProgressRounds 为 0/负数/非数字表示不启用（沿用本仓库"高上限兜底、非正常态硬墙"的原则）。
 *
 * @param {Object} input
 * @param {number} input.iter 当前迭代下标（从 0 起）
 * @param {number|null} input.lastProgressIter 最近一次有进展的迭代下标
 * @param {number} input.maxNoProgressRounds 允许的无进展轮数上限
 * @returns {{stalled:boolean, reason:string, noProgressRounds:number}}
 */
export function evaluateLiveness(input: Record<string, any> = {}) {
  const iter = Number(input.iter);
  const cap = Number(input.maxNoProgressRounds);
  const base = Number.isFinite(Number(input.lastProgressIter)) ? Number(input.lastProgressIter) : 0;
  const safeIter = Number.isFinite(iter) && iter > 0 ? iter : 0;
  const noProgressRounds = Math.max(0, safeIter - base);
  if (!Number.isFinite(cap) || cap <= 0) return { stalled: false, reason: '', noProgressRounds };
  if (noProgressRounds >= cap) return { stalled: true, reason: 'noProgress', noProgressRounds };
  return { stalled: false, reason: '', noProgressRounds };
}

// 导出以便单测：证据采集规则直接决定完成前校验能否通过，
// 而它出错的症状（校验器永远判未达成 → agent 手工取证）离代码很远。
export function evidenceAfter(prev: any, tc: any, res: any, summarizeArgs: any) {
  const text = res && typeof res.result === 'string' ? res.result : '';
  if (!text) return prev;
  // 证据文本同样来自页面原文 —— 按码元下标切会切裂代理对（见 surrogates.js 的事故说明）。
  if (EVIDENCE_READ_TOOLS.has(tc.name)) return sliceSafe(text, 0, 3000);
  let metadata = null;
  try {
    metadata = getToolMetadata(tc.name);
  } catch (e) {
    metadata = null;
  }
  // 只读动作（截图等）不改变页面，不能当作「做了事」的证据
  if (metadata && metadata.readOnly === true) return prev;
  // 有副作用的动作：把回执本身作为证据。失败也要记 —— 「最后一步失败了」
  // 对校验器同样是关键信息，隐瞒它只会换来一次被否决的 complete_task。
  return (
    '【最近一次页面动作】' + tc.name + (res.ok === false ? '（执行失败）' : '（已执行成功）') + '\n' +
    '参数：' + summarizeArgs(tc.args) + '\n' +
    '返回：' + text.slice(0, 2000) +
    '\n（备注：若同时提供了页面快照，那份快照是在本动作之前采集的。）'
  );
}

// 是否需要「完成前独立校验」：仅对会操作页面的浏览器/研究类任务、且确实调用过工具时启用。
//
// 导出是为了直接测这条**成本策略**（原先是模块内私有、零覆盖）：
// 它决定"什么时候多花一次模型调用"，答错的代价是**每次收尾都白花一次调用**，
// 或者反过来该校验时不校验。
/**
 * 完成校验用的「有效意图」。
 *
 * 为什么要单独导出这个函数（而不是在主循环里内联三元表达式）：`promoteToResearch`
 * 只换工具集与系统提示、**不改 intent**，所以「起点是 CHAT、中途被提升为研究画像」的
 * run 若照 `intent` 判定就会永远跳过 LLM 完成校验。这条判定必须是**可直接测的纯函数**，
 * 否则它只能靠人记得在两处保持一致。
 */
export function resolveVerifyIntent(intent: string, promotedToResearch: any) {
  return promotedToResearch ? INTENTS.RESEARCH : intent;
}

export function classifyTaskKind(ranToolNames: any) {
  const names = [...new Set((Array.isArray(ranToolNames) ? ranToolNames : []).filter(Boolean))];
  // 一次工具都没调过却走到这里（理论上不该发生）：按改过页面的严格问法处理，宁可多要一次证据。
  if (!names.length) return 'mutation';
  const allReadOnly = names.every((nm) => {
    try {
      return !changesState(getToolMetadata(nm as string));
    } catch (e) {
      // 元数据查不到（例如 MCP 工具）时**不能**当成只读：我们不知道它会改什么，
      // 按严格问法处理才是安全方向（放宽只会让「声称做了」更容易蒙混过关）。
      return false;
    }
  });
  return allReadOnly ? 'read' : 'mutation';
}

export function shouldVerifyCompletion(intent: string, toolCallCount: number, settings: any) {
  if (!settings || settings.verifierEnabled === false) return false;
  if (!settings.apiKey) return false;
  if (!toolCallCount) return false;
  return intent === INTENTS.BROWSER || intent === INTENTS.RESEARCH;
}

/**
 * 组装送给完成校验的证据。
 *
 * **两份都要给，缺一不可**（这是修过一次的回归）：
 * - `ctx.lastEvidence` 是「最近一次动作的回执」，回答**刚刚做了什么**
 *   （如「【最近一次页面动作】annotate({op:"highlight"})（已执行成功）… 返回：已高亮 12 / 12 处关键信息」）；
 * - `selectEvidence` 抽出的页面片段回答**结论与页面是否一致**。
 *
 * 曾经改成只用页面片段（把 lastEvidence 当作「没有全文时的退路」），
 * 结果有副作用的动作回执被整个挤掉 —— 校验方看不到「刚做了什么」，
 * 于是怀疑高亮是否真的存在，agent 又花十几次调用自证。
 * 纯函数，导出以便直接测「两者同时在场」这条装配性质。
 */
export function buildVerificationEvidence(ctx: any, claim: any) {
  const parts = [];
  if (ctx.lastSnapshot) parts.push(compactSnapshotSummary(ctx.lastSnapshot));
  const receipt = String(ctx.lastEvidence || '').slice(0, EVIDENCE_RECEIPT_CHARS);
  if (receipt) parts.push('【最近一次动作的回执】\n' + receipt);
  const picked = selectEvidence({
    fullText: ctx.lastReadFullText,
    fallback: ctx.lastEvidence,
    claim: String(claim || ''),
  });
  if (picked.text) parts.push('【页面相关片段】\n' + picked.text);
  if (picked.coverage) parts.push(picked.coverage);
  return parts.join('\n\n');
}

/**
 * 「这次送审的证据是否与上次被否决时完全相同」—— 用签名比较，而不是比较全文。
 *
 * 只取四个能代表"有没有产生新东西"的维度：
 *   · claim            —— 总结本身（换个说法也算变了，但换了说法却没做事，随后仍会被否决）
 *   · lastEvidence     —— 最近一次动作的回执（做了新动作就会变）
 *   · 页面指纹          —— 页面内容真的变了（零成本，快照自带）
 *   · 读类全文长度      —— 重新取证/换了一页（长度变说明读到了不同体量的内容）
 *
 * 为什么不用全文做签名：长任务里 lastReadFullText 可达几十万字，每次收尾都拼一遍既慢又占内存，
 * 而这四个维度已经足够回答"有没有新证据"这个二元问题。
 */
export function verifyEvidenceSignature(claim: any, ctx: any) {
  const c = ctx || {};
  return [
    String(claim || ''),
    String(c.lastEvidence || ''),
    String((c.lastSnapshot && c.lastSnapshot.fingerprint) || ''),
    String((c.lastReadFullText || '').length),
  ].join('\u0000');
}

/**
 * 「完成校验这一步的结果该怎么读」—— 纯函数，便于直测（agent 主循环本身不好单测）。
 *
 * 三种结局，混淆任意两种都会产生用户可见的错误：
 *   · `interrupt`  —— 用户中断。必须按中断收尾（保留已做的动作、状态记 interrupted），
 *                     **不能**当成「校验器故障 ⇒ 按通过放行」。否则一次「我按了停止」
 *                     会以「任务已完成」被持久化，用户看到的却是「已按通过放行」。
 *   · `fail-open`  —— 校验器不可用（超时 / 报错 / 无 API Key / 返回空）。它是安全网，
 *                     自己坏掉不该卡住用户 ⇒ 放行，但必须让前端看得见。
 *   · `verdict`    —— 有结论，按 ok / !ok 分派。
 *
 * 只认 `error.name === 'AbortError'`；其它异常一律算故障（verifier.js 已保证
 * 中断会以 AbortError 抛出，而不是 return null）。
 */
export function classifyVerifyOutcome(verdict: any, error: any) {
  if (error) {
    if (error.name === 'AbortError') return { kind: 'interrupt' };
    return { kind: 'fail-open' };
  }
  if (!verdict) return { kind: 'fail-open' };
  return { kind: 'verdict', verdict };
}

