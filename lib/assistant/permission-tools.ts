// 权限与页面会话状态（trust_site / handle_dialog）—— C-1 拆出的第 4 族。
//
// 为什么这两者算一族：它们都**改变后续动作的放行方式或页面会话状态** ——
// 一个把站点加进信任列表（此后该站写操作不再逐次确认），一个回应阻塞页面的原生对话框。
// 换句话说，它们不"读页面"也不"改页面"，而是改**规则与待决状态**。
//
// **搬运原则：不重写行为。** 实现从 tools.js 原样搬来，闭包依赖改显式注入。
//
// 安全注意（写在这里以免以后有人"顺手放宽"）：
//   · `trust_site` 会直接影响 `toolNeedsApproval` 的结果（信任站点 → 写操作免确认）；
//   · 但它**不能**覆盖 `alwaysRequireApproval`（用户脚本 / 技能写入仍每次确认）——
//     那句话就写在返回文案里，是给模型与用户看的承诺。
import { siteKeyOf } from '../shared/url.ts';
import type { Caught } from './errors.ts';
import type { PermissionDeps } from './tool-deps.ts';

/** 把当前站点加入信任列表（原 trust_site）。 */
export async function trustSite(deps: PermissionDeps) {
  const ctx = deps.ctx;
  // 与 toolNeedsApproval 用**同一个**站点键：否则本地页会出现
  // "trust_site 说信任了 'null'、审批时却按目录去查"这种永不生效的信任。
  const origin = siteKeyOf(ctx.pageUrl);
  if (!origin) return { ok: false, result: '无法确定当前站点。' };
  const list = Array.isArray(ctx.settings.trustedSites) ? ctx.settings.trustedSites.slice() : [];
  if (!list.includes(origin)) list.push(origin);
  ctx.settings.trustedSites = list;
  try {
    await deps.chrome.storage.local.set({ aiSettings: Object.assign({}, ctx.settings, { trustedSites: list }) });
  } catch (e) {}
  return {
    ok: true,
    result: '已信任站点 ' + origin + '：此站点的写操作将不再逐次确认（用户脚本 / 技能写入等高风险工具仍每次确认）。',
  };
}

/** 回应页面对话框（原 handle_dialog）。 */
export async function handleDialogTool(deps: PermissionDeps, args: Record<string, unknown>) {
  const ctx = deps.ctx;
  if (!deps.cdpAllowed(ctx)) return { ok: false, result: '处理对话框需要 CDP（请在设置中开启）。' };
  try {
    await deps.handleDialog(ctx.tabId, args.accept !== false, args.promptText as string | undefined);
    return { ok: true, result: (args.accept !== false ? '已接受' : '已取消') + '页面对话框。' };
  } catch (e) {
    return { ok: false, result: '处理对话框失败：' + deps.summarizeCdpError(e as Caught) };
  }
}

/** 该族处理哪些工具名。 */
export const PERMISSION_TOOLS = new Set(['trust_site', 'handle_dialog']);

/** 统一入口。返回 null 表示"不属于本族"。 */
export async function handlePermissionTool(name: string, args: Record<string, unknown>, deps: PermissionDeps) {
  if (name === 'trust_site') return await trustSite(deps);
  if (name === 'handle_dialog') return await handleDialogTool(deps, args);
  return null;
}
