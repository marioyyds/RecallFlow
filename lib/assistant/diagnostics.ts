import type { Caught } from './errors.ts';
import type { DiagnosticsDeps, SendTabMessage } from './tool-deps.ts';
// 诊断类工具（read_console / read_network / list_downloads）→ 收敛为 read_diagnostics(kind)。
//
// C-4 合并第 3 档（见 docs/tool-merge-plan.md）：三个工具都是"读环境事实"，权限完全一致（全是 read），
// 因此合并**不涉及权限变化**，是这一轮里最安全的一档。
//
// 合并原则（重要）：**不重写行为，只换入口**。
// 每个 kind 的实现是从 tools.js 原样搬过来的，只把 `ctx.tabId`、`args.*` 换成显式参数。
// 这样"合并"不会顺手改掉已有语义 —— 后者是这类重构最容易引入回归的地方。
//
// 权限注意：本模块只做读操作，不得引入任何写行为；`list_downloads` 读的是本任务已捕获的下载记录，
// 不会触发新下载。

/** 读取 console 记录（原 read_console 的实现）。 */
export async function readConsole(sendTabMessage: SendTabMessage, tabId: number, args: Record<string, unknown>) {
  if (!tabId) return { ok: false, result: '无法定位当前标签页（可能不在前台页面）。' };
  try {
    const res = await sendTabMessage(tabId, { type: 'kbGetConsole' });
    let entries = (res && res.entries) || [];
    if (args.level) entries = entries.filter((e) => e.level === args.level);
    const limit = Math.min(200, Math.max(1, Number(args.limit) || 50));
    entries = entries.slice(-limit);
    if (!entries.length) return { ok: true, result: '暂无 console 记录。' };
    const text = entries.map((e) => '[' + (e.level as string) + '] ' + (e.text as string) + (e.stack ? '\n' + (e.stack as string) : '')).join('\n');
    return { ok: true, result: '最近 console 记录（' + entries.length + ' 条）：\n' + text };
  } catch (e) {
    return { ok: false, result: '读取 console 失败：' + (e as Caught).message };
  }
}

/** 读取网络请求记录（原 read_network 的实现）。 */
export async function readNetwork(sendTabMessage: SendTabMessage, tabId: number, args: Record<string, unknown>) {
  if (!tabId) return { ok: false, result: '无法定位当前标签页（可能不在前台页面）。' };
  try {
    const res = await sendTabMessage(tabId, { type: 'kbGetNetwork' });
    let entries = (res && res.entries) || [];
    if (args.filter) {
      const f = String(args.filter);
      entries = entries.filter((e) => String(e.url || '').includes(f));
    }
    const limit = Math.min(200, Math.max(1, Number(args.limit) || 50));
    entries = entries.slice(-limit);
    if (!entries.length) return { ok: true, result: '暂无网络请求记录。' };
    const text = entries
      .map((e) => {
        const head = (e.method || 'GET') + ' ' + (e.error ? 'ERR' : (e.status || '')) + ' ' + (e.url as string) + (e.ms != null ? ' (' + e.ms + 'ms)' : '') + (e.error ? ' — ' + e.error : '');
        const init = e.initiator ? (e.initiator as string).split('\n').slice(0, 2).join(' ') : '';
        return head + (init ? '\n  发起于: ' + init : '');
      })
      .join('\n');
    return { ok: true, result: '最近网络请求（' + entries.length + ' 条）：\n' + text };
  } catch (e) {
    return { ok: false, result: '读取网络请求失败：' + (e as Caught).message };
  }
}

/** 列出本任务已捕获的下载（原 list_downloads 的实现）。 */
export function listDownloads(getDownloads: DiagnosticsDeps['getDownloads'], tabId: number) {
  const list = getDownloads(tabId);
  if (!list.length) return { ok: true, result: '本任务暂未捕获到下载。' };
  return {
    ok: true,
    result: '捕获到的下载：\n' + list.map((d, i) => '[' + (i + 1) + '] ' + (d.suggestedFilename || '') + ' ← ' + d.url).join('\n'),
  };
}

/** 合法的 kind 值。显式列出（而不是只看默认分支），便于报错时给出可用选项。 */
export const DIAGNOSTIC_KINDS = ['console', 'network', 'downloads'];

/**
 * 统一入口：read_diagnostics({ kind, ... })。
 *
 * `kind` 是**必填**（schema 里 required）。缺省时返回明确的错误而不是猜一个默认值 ——
 * 猜默认会让"想看网络却拿到 console"这种错误静默发生，模型只会以为"没有网络请求"。
 */
export async function readDiagnostics(deps: DiagnosticsDeps, args: Record<string, unknown>) {
  const kind = String((args && args.kind) || '').trim();
  if (!kind) {
    return { ok: false, result: 'read_diagnostics 需要 kind 参数，取值：' + DIAGNOSTIC_KINDS.join(' / ') + '。' };
  }
  if (kind === 'console') return await readConsole(deps.sendTabMessage, deps.tabId, args);
  if (kind === 'network') return await readNetwork(deps.sendTabMessage, deps.tabId, args);
  if (kind === 'downloads') return listDownloads(deps.getDownloads, deps.tabId);
  return { ok: false, result: '未知的 kind「' + kind + '」，取值：' + DIAGNOSTIC_KINDS.join(' / ') + '。' };
}
