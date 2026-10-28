// 工具审批判定（纯函数，零 chrome 依赖，可直接 import 单测）
//
// 为什么从 agent.js 搬出来：这段逻辑曾是 agent.js 里唯一"决定要不要打断用户"的代码，
// 却只能通过 import 一个 2200 行、顶层直接引用 chrome API 的模块来测。
// 结果就是它长期只有 5 条断言，且其中最关键的一档（任意代码执行）零测试 ——
// 把那一档的分支改成恒 false，1720 条测试没有一条变红。
// 判定规则是**安全边界**，不该和"编排循环"耦合在同一个文件里。
import { getToolMetadata } from './tools.ts';
import { resolveCodeExecutionApproval } from '../shared/settings.ts';
import { siteKeyOf } from '../shared/url.ts';

/**
 * risk → 审批类别（UI 里那 5 个勾选项）的**显式**映射。
 *
 * 为什么必须显式：16 个页面写操作工具标的是 `risk:'page'`，此前没有对应分支，
 * 全部落到默认的 `'commands'` —— 行为正确，但完全依赖默认值兜底。
 * 后续调默认值或新增风险等级时会**静默错配**，而错配的方向可能是放行。
 *
 * `'read'` 也在这里：读类工具通常 `requiresApproval !== true`，走不到映射，
 * 但一旦某个读工具被标成需要审批，它应该落到「读取」这一档，而不是「页面命令」。
 */
export const APPROVAL_CATEGORY_BY_RISK: Record<string, any> = Object.freeze({
  read: 'read',
  page: 'commands',
  write: 'edit',
  destructive: 'edit',
  browser: 'browser',
  network: 'browser',
  external: 'mcp',
});

/**
 * 有意**不**映射的风险等级。
 *
 * `'high'` 的语义是「这条工具无论如何都要用户点头」，由 `alwaysRequireApproval`
 * 分支负责，**不该**再由类别自动批准兜底。所以这里不给它类别：
 * 万一某天有人写了 `risk:'high'` 却忘了 `alwaysRequireApproval`，
 * `resolveApprovalCategory` 返回 null ⇒ `toolNeedsApproval` fail-closed（照样弹窗），
 * 而不是默默落进 `'commands'` 被用户勾的「页面命令自动批准」放行。
 */
export const RISK_WITHOUT_CATEGORY = Object.freeze(['high']);

/**
 * @param {string} risk 工具的 `risk` 元数据
 * @returns {string|null} 审批类别；null 表示"没有可用的类别自动批准途径"（调用方必须 fail-closed）
 */
export function resolveApprovalCategory(risk: any) {
  if (typeof risk !== 'string') return null;
  const hit = APPROVAL_CATEGORY_BY_RISK[risk];
  return typeof hit === 'string' ? hit : null;
}

/**
 * 这个工具调用是否需要用户明确批准。
 *
 * ⚠ 传入的 `settings` 必须已经过 `readLiveApprovalSettings` 现读 ——
 * 用运行开始时那份快照会让"对话进行中改设置"失效（两个方向都错，见该函数注释）。
 *
 * @param {string} name 工具名
 * @param {Object} [settings] 现读的审批设置
 * @param {string} [pageUrl] 当前页面 URL（用于站点信任判定）
 * @returns {boolean}
 */
export function toolNeedsApproval(name: string, settings: Record<string, any> = {}, pageUrl = '') {
  const meta = getToolMetadata(name);
  if (meta.requiresApproval !== true) return false;
  // 仍有独立"任意代码执行"审批档的工具（run_userscript / install_userscript / save_skill）：
  // 默认进入审批流程；用户可在设置中选择「本任务内允许」或「自动批准」。
  // 注意：'session' 仍需弹一次审批，之后由会话级放行（sessionApprovedTools）跳过；'auto' 完全不弹。
  // 这一档**不参与** toolApprovalPolicy 的类别自动批准，也不受站点信任影响。
  if (meta.alwaysRequireApproval === true) {
    return resolveCodeExecutionApproval(settings) !== 'auto';
  }
  // 站点信任：已信任站点的写操作不再逐次确认。
  // 站点键必须与 `trust_site` 写入时一致（见 lib/assistant/permission-tools.js）：
  // 本地页的 `URL.origin` 恒为 'null'，直接用会把"信任了某个本地目录"变成"信任了所有本地文件"。
  if (pageUrl) {
    const origin = siteKeyOf(pageUrl);
    const trusted = Array.isArray(settings.trustedSites) ? settings.trustedSites : [];
    if (origin && trusted.includes(origin)) return false;
  }
  // 有意**不**做的一件事：不因为「本次提示里含不可信页面内容」就强制所有写操作逐次审批。
  //
  // 理由：那会让两处用户显式设置（trustedSites 站点信任、toolApprovalPolicy 类别自动批准）
  // 被一条不可见的规则悄悄推翻 —— 用户在设置里勾了"信任这个站点"，却因为当前页面碰巧
  // 含某段文字而反复弹窗，且他无从知道原因。**不可预测的审批比没有审批更糟**：
  // 用户会学会无脑点"同意"，而真正的风险时刻就混在这些弹窗里被点掉了。
  //
  // 注入的防线应当放在**结构**上（见 lib/assistant/initial-messages.js：数据用定界符封闭、
  // 指令带随机校验标记），而不是在审批环节无差别加闸。若将来要做上下文相关加闸，
  // 前提是同时给出**可见的理由**（面板里说明"本任务含不可信页面内容"），
  // 让用户能理解为什么这次不同 —— 那是一次独立的产品决定。
  const category = resolveApprovalCategory(meta.risk);
  // 没有类别的风险等级一律 fail-closed：宁可多问一次，也不能靠默认值放行。
  if (!category) return true;
  const p = settings.toolApprovalPolicy || {};
  return p[category] !== true;
}
