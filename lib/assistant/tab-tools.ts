import type { Caught } from './errors.ts';
import type { RunCtx, PageSnapshotLike } from './types.ts';
import type { TabDeps } from './tool-deps.ts';
// 标签页族（list_tabs / switch_tab / open_tab）—— 从 tools.js 的巨型 switch 里拆出的第一族。
//
// 为什么要拆：`executeTool` 曾是一个 1000+ 行的 switch，所有工具族（标签页、抓取、页面命令、
// 知识库、诊断…）都挤在同一个函数里，互相之间只靠 `ctx` 隐式耦合。
// 拆成"一族一个模块 + 显式依赖注入"之后：
//   · 这一族的能力边界一眼可见（它只碰 chrome.tabs / 会话绑定 / 页就绪等待）；
//   · 不依赖 chrome.* 即可单测（把 tabApi 换成假的）。
//
// **搬运原则：不重写行为。** 下面的实现是从 tools.js 原样搬过来的，
// 只把原来靠在闭包里的 `chrome` / `ctx` / 若干私有 helper 换成显式参数。
// 这不是"顺手改进"的机会 —— 混合搬运与改进会让回归无法归因。
//
// 依赖（由调用方注入）：
//   chrome      —— 只用 tabs.query / tabs.get / tabs.update / tabs.create
//   ctx         —— 会被读取与就地更新（openedTabCount / browsingMode / maxOpenedTabs /
//                  tabSwitchCount / maxTabSwitches）
//   waitForTabReady / bindSessionTab / listOpenedTabsSummary / trackOpenedTab / ensureAgentWindow

const DEFAULT_MAX_TAB_SWITCHES = 6;

function tabSwitchBudget(ctx: RunCtx) {
  const used = Math.max(0, Number(ctx && ctx.tabSwitchCount) || 0);
  const max = Math.max(1, Number(ctx && ctx.maxTabSwitches) || DEFAULT_MAX_TAB_SWITCHES);
  return { used, max, exhausted: used >= max };
}

function countTabSwitch(ctx: RunCtx) {
  if (!ctx) return;
  ctx.tabSwitchCount = Math.max(0, Number(ctx.tabSwitchCount) || 0) + 1;
}

function tabSwitchLimitMessage(used: number, max: number) {
  return (
    '本任务已切换标签页 ' + used + ' 次（上限 ' + max + '），为减少对用户的打扰，不再继续切换。' +
    '请留在当前页完成；需要另一页的数据时，优先使用已读到的快照/工具结果或 fetch_webpage，不要来回切换。'
  );
}

/** 列出当前窗口的标签页（原 list_tabs）。 */
export async function listTabs(deps: TabDeps) {
  try {
    const tabs = await deps.chrome.tabs.query({ currentWindow: true });
    const visibleTabs = tabs.filter((t) => t.url);
    const tabInfo = visibleTabs.map((t) => ({
      tabId: t.id,
      windowId: t.windowId,
      title: t.title || '',
      url: t.url || '',
      active: Boolean(t.active),
    }));
    const text = visibleTabs
      .filter((t) => t.url)
      .map((t, i) => `[${i + 1}] tabId=${t.id} ${t.active ? '（当前）' : ''} ${t.title || ''}｜${t.url}`)
      .join('\n');
    return { ok: true, tabs: tabInfo, result: '当前窗口标签页：\n' + (text || '（无）') };
  } catch (e) {
    return { ok: false, result: '列出标签页失败：' + (e as Caught).message };
  }
}

/** 切换活动标签页并等它就绪（原 switch_tab）。 */
export async function switchTab(deps: TabDeps, args: Record<string, unknown>) {
  const tabId = Number(args && args.tabId);
  if (!Number.isInteger(tabId) || tabId <= 0) return { ok: false, result: 'tabId 必须是有效的标签页 ID' };
  const currentId = Number(deps.ctx && deps.ctx.tabId);
  if (Number.isInteger(currentId) && currentId === tabId) {
    return {
      ok: true,
      noop: true,
      activated: false,
      targetTabId: tabId,
      result: '当前已经绑定该标签页（tabId=' + tabId + '），无需重复 switch_tab；请直接在当前页完成操作。',
    };
  }
  const budget = tabSwitchBudget(deps.ctx);
  try {
    const target = await deps.chrome.tabs.get(tabId);
    if (!target || !target.id) return { ok: false, result: '未找到标签页：' + tabId };
    // 浏览器里目标页已经是前台页时，不要再 update(active:true)：这既没有视觉效果，
    // 又会把「一次真实跳转」浪费在无意义的调用上。只同步 Agent 的绑定。
    const activated = target.active !== true;
    if (activated) {
      if (budget.exhausted) {
        return {
          ok: false,
          blocked: true,
          result: tabSwitchLimitMessage(budget.used, budget.max),
        };
      }
      await deps.chrome.tabs.update(tabId, { active: true });
      countTabSwitch(deps.ctx);
    }
    const snapshot = await deps.waitForTabReady(tabId, 5000);
    const current = await deps.chrome.tabs.get(tabId).catch(() => target);
    const targetTab = {
      tabId,
      windowId: current.windowId || target.windowId,
      title: current.title || target.title || '',
      url: current.url || target.url || '',
      ready: Boolean(snapshot),
    };
    // 同步该标签页的弹窗开关状态，跟随 Agent 当前绑定 tab。
    deps.bindSessionTab(tabId);
    return {
      ok: true,
      activated,
      targetTabId: tabId,
      targetTab,
      pageSnapshot: snapshot,
      result:
        (activated ? '已切换到标签页 ' : '已绑定标签页 ') + 'tabId=' + tabId + '：' + (target.title || target.url || '') +
        (snapshot ? '（页面已就绪）' : '（内容脚本尚未就绪）') +
        (activated ? '\n后续请留在该页完成操作，不要为验证/对比反复切回。' : '\n该页已在后台/前台就绪，无需再次切换。'),
    };
  } catch (e) {
    return { ok: false, result: '切换标签页失败：' + (e as Caught).message };
  }
}

/**
 * 打开（或复用）标签页并绑定（原 open_tab）。
 *
 * 三条有意保留的语义：
 *   · `newTab !== true` 时先按 URL **去重复用**，避免 tab 越开越多；
 *   · `isolated` 模式下**不激活**标签、改用 agent 自己的窗口，不抢用户前台视图；
 *   · 达到"累计新建数"上限时**软拒绝**（列出已开标签页 + 引导复用/抓取），
 *     而不是硬失败 —— 硬失败会让模型反复重试开页，白烧预算。
 */
export async function openTab(deps: TabDeps, args: Record<string, unknown>) {
  const ctx = deps.ctx;
  try {
    const url = String((args && args.url) || '');
    // 本地文件（file://）**有意**不在这里放行 —— 这是产品决策，不是遗漏。
    // 扩展本身支持操作"用户自己已经打开的本地页"（见 manifest 的 file:///* 与
    // lib/shared/utils.js 的 isOperableUrl），但**不允许 agent 主动去打开磁盘上的路径**：
    // 那等于给它一个逐路径探测本机文件的读口（`open_tab('file:///C:/Users/...')` + 读正文）。
    // 需要读本地文件时由用户自己双击打开，那个标签页照常可读可点。
    if (/^file:\/\//i.test(url)) {
      return {
        ok: false,
        result:
          'open_tab 不支持本地文件路径（避免 agent 探测本机磁盘）。请让用户自己在浏览器里打开该文件，' +
          '打开后再用 read_current_page / switch_tab 读取它。',
      };
    }
    if (!/^https?:\/\//i.test(url)) return { ok: false, result: 'open_tab 仅支持 http/https 链接：' + url };
    const forceNew = args.newTab === true;
    // 隔离模式（研究/知识库/对话）：不激活标签、不抢用户前台视图，静默复用/读取。
    const isolated = ctx.browsingMode === 'isolated';
    // 默认复用已打开的同 URL 标签页（去重，避免 tab 越开越多）。
    if (!forceNew) {
      const existing = await deps.chrome.tabs.query({ url }).catch(() => []);
      const hit = Array.isArray(existing) && existing.find((t) => t.id && /^https?:/i.test(t.url || ''));
      if (hit) {
        const alreadyActive = Number(ctx.tabId) === Number(hit.id) && hit.active !== false;
        const budget = tabSwitchBudget(ctx);
        let activated = false;
        let switchSuppressed = false;
        // 已经绑定并处于前台的页不要再 update(active:true)：那会让用户感觉标签页被无意义地重选。
        if (!isolated && !alreadyActive) {
          if (budget.exhausted) {
            switchSuppressed = true;
          } else {
            await deps.chrome.tabs.update(hit.id as number, { active: true });
            countTabSwitch(ctx);
            activated = true;
          }
        }
        const snapshot = await deps.waitForTabReady(hit.id as number, 5000);
        const current = await deps.chrome.tabs.get(hit.id as number).catch(() => hit);
        const targetTab = {
          tabId: hit.id,
          windowId: current.windowId || hit.windowId,
          title: current.title || hit.title || '',
          url: current.url || hit.url || url,
          ready: Boolean(snapshot),
        };
        deps.bindSessionTab(hit.id as number);
        return {
          ok: true,
          reused: true,
          activated,
          targetTabId: hit.id,
          targetTab,
          pageSnapshot: snapshot,
          result:
            '已复用已打开的标签页 tabId=' + hit.id + '：' + targetTab.url +
            (snapshot ? '（页面已就绪）' : '（内容脚本尚未就绪）') +
            (alreadyActive
              ? '\n该页已是当前工作页，无需再切换。'
              : activated
                ? '\n请留在该页完成操作，不要为验证/对比反复切回。'
                : switchSuppressed
                  ? '\n' + tabSwitchLimitMessage(budget.used, budget.max) + '已绑定目标页但未切到前台，后续可直接读取/操作。'
                  : ''),
        };
      }
    }
    // 标签页预算：按「累计新建数」限制（而非当前存活数，避免中途清理导致反复重开）。
    // 达到上限时软拒绝：给出已打开标签页清单，引导模型复用/抓取，而不是硬失败后反复重试。
    const openedCount = Number(ctx.openedTabCount || 0);
    if (openedCount >= Number(ctx.maxOpenedTabs || 5)) {
      const summary = await deps.listOpenedTabsSummary(ctx).catch(() => '');
      return {
        ok: false,
        blocked: true,
        result:
          '本任务已新建 ' + openedCount + ' 个标签页，达到上限（' + (ctx.maxOpenedTabs || 5) + '），禁止继续新建。' +
          (summary ? '\n当前已打开的标签页：\n' + summary : '') +
          '请改用 switch_tab 复用上面的标签页（tabId），或改用 fetch_webpage 直接抓取内容；不要再调用 open_tab。',
      };
    }
    const budget = tabSwitchBudget(ctx);
    const openActive = !isolated && !budget.exhausted;
    const t = isolated
      ? await deps.chrome.tabs.create({ url, windowId: await deps.ensureAgentWindow(ctx), active: false })
      : await deps.chrome.tabs.create({ url, active: openActive });
    if (!t || !t.id) return { ok: false, result: '打开标签页失败：浏览器未返回 tabId' };
    if (openActive) countTabSwitch(ctx);
    ctx.openedTabCount = openedCount + 1;
    deps.trackOpenedTab(ctx, t.id);
    const snapshot = await deps.waitForTabReady(t.id, 8000);
    deps.bindSessionTab(t.id);
    const current = await deps.chrome.tabs.get(t.id).catch(() => t);
    const targetTab = {
      tabId: t.id,
      windowId: current.windowId || t.windowId,
      title: current.title || t.title || '',
      url: current.url || t.url || ((args && args.url) as string) || '',
      ready: Boolean(snapshot),
    };
    return {
      ok: true,
      activated: openActive,
      targetTabId: t.id,
      targetTab,
      pageSnapshot: snapshot,
      result:
        (openActive ? '已在新标签页打开并绑定：' : '已在新标签页（后台）打开并绑定：') +
        'tabId=' + t.id + ' ' + (t.url || (args && args.url)) +
        (snapshot ? '（页面已就绪）' : '（内容脚本尚未就绪）') +
        (!openActive && !isolated ? '\n' + tabSwitchLimitMessage(budget.used, budget.max) : ''),
    };
  } catch (e) {
    return { ok: false, result: '打开标签页失败：' + (e as Caught).message };
  }
}

/** 该族是否处理这个工具名。 */
export const TAB_TOOLS = new Set(['list_tabs', 'switch_tab', 'open_tab']);

/** 统一入口（由 executeTool 分派）。返回 null 表示"不属于本族"。 */
export async function handleTabTool(name: string, args: Record<string, unknown>, deps: TabDeps) {
  if (name === 'list_tabs') return await listTabs(deps);
  if (name === 'switch_tab') return await switchTab(deps, args);
  if (name === 'open_tab') return await openTab(deps, args);
  return null;
}
