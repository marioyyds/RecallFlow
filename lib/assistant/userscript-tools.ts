// 用户脚本族（list_userscripts / search_userscripts / install_userscript / run_userscript）
// —— C-1 拆出的第 9 族。
//
// 为什么这四者算一族：它们围绕同一个对象（用户脚本）做**列出 / 搜索 / 安装 / 执行**。
// 放在一起后，"谁能安装脚本、安装受什么限制、执行前有没有确认"这几件事一眼可见。
//
// **搬运原则：不重写行为。** 实现从 tools.js 原样搬来，闭包依赖改为显式注入。
//
// ⚠ 两条**有意保留**的语义（都关系到安全边界）：
//   1. `install_userscript` 必须先读**用户设置** `agentCanInstall`：用户关掉之后
//      Agent 不得自行安装（这不是"建议"，是用户明确表达的拒绝）。
//   2. `run_userscript` 的失败要用 `r.error`（而不是 `r.result`）—— 那是运行时给出的
//      具体原因（匹配不上、脚本报错等），直接把它当结果会把可读原因吞掉。

/** 列出已安装的用户脚本（原 list_userscripts）。 */
import type { UserscriptDeps } from './tool-deps.ts';

export async function listUserscriptsTool(deps: UserscriptDeps) {
  const scripts = await deps.listUserscripts();
  const text = scripts.length
    ? scripts
        .map(
          (s: any, i: any) =>
            `[${i + 1}] ${s.name} v${s.version}${s.enabled ? '' : '（已停用）'}\n` +
            `id：${s.id}\n匹配：${(s.matches || []).join('、')}\n描述：${s.description || '无'}`
        )
        .join('\n\n')
    : '尚未安装任何用户脚本。';
  return { ok: true, result: '已安装的用户脚本：\n' + text };
}

/** 在 GreasyFork 上搜索用户脚本（原 search_userscripts）。 */
export async function searchUserscripts(deps: UserscriptDeps, args: Record<string, unknown>) {
  const list = await deps.searchScripts(args.query as string);
  return {
    ok: true,
    result: list.length
      ? 'GreasyFork 搜索结果：\n' +
        list
          .map((it: any, i: any) => `[${i + 1}] ${it.name}（安装 ${it.installs}）\n${it.description}\ncode_url：${it.codeUrl}`)
          .join('\n\n')
      : '未找到相关脚本',
  };
}

/**
 * 从 URL 安装用户脚本（原 install_userscript）。
 *
 * 先查用户设置：`agentCanInstall` 为假时**直接拒绝**，并且要明确告诉用户
 * "是你自己在设置里关的、去哪里打开"—— 而不是含糊地说"安装失败"。
 */
export async function installUserscript(deps: UserscriptDeps, args: Record<string, unknown>) {
  const usSettings = await deps.getUserscriptSettings();
  if (!usSettings.agentCanInstall) {
    return { ok: false, result: '用户已在设置中关闭“允许 Agent 安装脚本”，请打开设置页开启后再试。' };
  }
  const r = await deps.installFromUrl(args.url as string);
  return {
    ok: true,
    result:
      '已安装用户脚本：' + r.script.name + ' v' + r.script.version +
      '\n匹配：' + (r.script.matches || []).join('、') +
      (r.script.warnings && r.script.warnings.length ? '\n警告：' + r.script.warnings.join('；') : ''),
  };
}

/** 在当前标签页执行指定用户脚本（原 run_userscript）。 */
export async function runUserscript(deps: UserscriptDeps, args: Record<string, unknown>) {
  const r = await deps.runUserscriptOnTab(deps.ctx.tabId, args.scriptId as string);
  return r.ok ? { ok: true, result: r.result } : { ok: false, result: r.error };
}

/** 该族处理哪些工具名。 */
export const USERSCRIPT_TOOLS = new Set(['list_userscripts', 'search_userscripts', 'install_userscript', 'run_userscript']);

/** 统一入口。返回 null 表示"不属于本族"。 */
export async function handleUserscriptTool(name: string, args: Record<string, unknown>, deps: UserscriptDeps) {
  if (name === 'list_userscripts') return await listUserscriptsTool(deps);
  if (name === 'search_userscripts') return await searchUserscripts(deps, args);
  if (name === 'install_userscript') return await installUserscript(deps, args);
  if (name === 'run_userscript') return await runUserscript(deps, args);
  return null;
}
