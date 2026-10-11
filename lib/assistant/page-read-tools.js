// 页面读取族（read_current_page / get_page_snapshot / list_frames）—— C-1 拆出的第 8 族。
//
// 为什么这三者算一族：它们是 Agent 的"眼睛" —— 正文、结构化快照、框架结构，
// 都是**只读地把页面现状取回来**。它也是唯一直接依赖 `chrome.scripting.executeScript`
// 枚举框架的地方（`listFramesRaw` 随本族一起搬过来）。
//
// **搬运原则：不重写行为。** 实现从 tools.js 原样搬来，闭包依赖改为显式注入。
//
// ⚠ 三条**有意保留**的语义（都踩过坑，不要"顺手简化"）：
//   1. `read_current_page` 的**核查模式**：调用方传了 `checkTexts` 时只回答
//      "这几段文案还在不在/可不可见"，**不返回正文、也不登记引用**。
//   2. **404 / 无内容页不登记为参考来源**：否则模型真正引用的内容会被推到高序号。
//      无标题页面的引用标题**不能回落到正文开头**（见 citationTitleFor 的说明）。
//   3. `get_page_snapshot` 的 **includeFrames 合并后仍要过体积预算**：
//      否则最多 150 个元素一起塞进来，绕开快照本身的 SNAPSHOT_CHAR_BUDGET。

// 纯函数直接 import，不走 deps 注入：它没有"需要替换"的场景，
// 而走 deps 会让**所有**既有调用方（含本仓库两条既有测试）都得补这个依赖，破坏面大于收益。
import { describeContentScriptUnreachable } from '../shared/utils.js';

/**
 * 枚举标签页内的所有框架（含跨域 iframe）。
 *
 * 用 `chrome.scripting.executeScript` 而不是内容脚本消息：这样才能一次拿到
 * **所有框架**（含跨域）的 href/title，而内容脚本只能报自己所在的那一个。
 */
export async function listFramesRaw(deps, tabId) {
  try {
    const results = await deps.chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => ({ href: location.href, title: document.title || '', isTop: window.top === window }),
    });
    return (results || []).map((r) => Object.assign({ frameId: r.frameId }, r.result || {}));
  } catch (e) {
    return [];
  }
}

/** 给某框架快照的元素 ref 加 f<frameId>: 前缀，使跨框架 ref 全局唯一、可路由。 */
export function prefixFrameRefs(snapshot, frameId) {
  if (!snapshot || !Number.isInteger(Number(frameId)) || Number(frameId) === 0) return snapshot;
  const fid = Number(frameId);
  const elements = (snapshot.elements || []).map((e) => Object.assign({}, e, { ref: 'f' + fid + ':' + e.ref, frameId: fid }));
  return Object.assign({}, snapshot, { elements, frameId: fid });
}

/** read_current_page：读正文（或核查若干文案是否可见）。 */
export async function readCurrentPage(deps, args) {
  const ctx = deps.ctx;
  const tabId = ctx.tabId;
  if (!tabId) return { ok: false, result: '无法定位当前标签页（可能不在前台页面）。' };
  try {
    const pageResponse = await deps.sendTabMessage(tabId, {
      type: 'kbGetPageText',
      options: {
        visibleOnly: args.visibleOnly === true,
        checkTexts: Array.isArray(args.checkTexts) ? args.checkTexts : undefined,
      },
    });
    const pr = pageResponse || {};
    const text = pr.text ? pr.text : '';
    const visReport = deps.formatVisibilityReport(pr.visibility);
    const checkTexts = Array.isArray(args.checkTexts) ? args.checkTexts : [];
    // 核查模式：调用方传了 checkTexts，说明它只想知道「这几段文案还在不在、可不可见」。
    // 此时不返回正文、也不登记引用（详见 formatCurrentPageResult 的注释）。
    if (checkTexts.filter((t) => String(t == null ? '' : t).trim()).length && visReport) {
      return {
        ok: true,
        result: deps.formatCurrentPageResult({ title: pr.title, url: pr.url || ctx.pageUrl, textLength: text.length, visReport, checkTexts, visibleOnly: args.visibleOnly === true }),
      };
    }
    if (!text) return { result: '未能读取页面正文（内容脚本未注入或页面不支持）。' };
    const chunks = deps.splitIntoChunks(text, 1200, 8);
    // 正文不再带 [n] 分块编号（避免与全局参考来源编号冲突）；来源编号由 Agent 层
    // 在登记引用后统一追加「参考来源 [X]」锚点，模型据此引用即可保证链接正确。
    const result = deps.formatCurrentPageResult({
      title: pr.title,
      url: pr.url || ctx.pageUrl,
      text,
      textLength: text.length,
      chunks,
      visReport,
      visibleOnly: args.visibleOnly === true,
    });
    // 404 / 无内容页面不作为参考来源登记，避免模型真正引用的内容被推到高序号。
    const is404 = /(404|page not found|not found|页面不存在|无法访问)/i.test(String(pageResponse.title || ''));
    // 无标题页面的引用标题**不能回落到正文开头**（见 citationTitleFor 的说明）。
    const urlForTitle = String(pageResponse.url || ctx.pageUrl || '');
    const citations = is404
      ? []
      : chunks.map((c, i) => ({
          index: i + 1,
          source: 'page',
          title: deps.citationTitleFor(pageResponse.title, urlForTitle),
          url: urlForTitle,
          snippet: c,
        }));
    return { result, citations };
  } catch (e) {
    // ⚠ 必须带 `ok: false` —— 它是**下游信号**：失败摘除、卡死检测、完成校验、
    // 以及模型的自我纠错都读它。这里原先只返回 result 文本，工具在转写里显示成
    // **✓ 成功**、内容却是「读取页面失败：Could not establish connection...」（B 站那次
    // 实测连续出现 5 次），模型因此以为"读到了、只是内容为空"，换了 5 种读法才自己悟出来。
    //
    // 同文件的 getPageSnapshotTool 一直是正确的（`ok:false` + 可操作文案）——
    // 这是同一个文件里的不一致，不是设计取舍。
    //
    // 文案另外要**可操作**：把"连不上内容脚本"翻成下一步能做什么（docs/tool-design.md §7）。
    return { ok: false, result: describeContentScriptUnreachable(e.message, '读取页面失败：') };
  }
}

/** get_page_snapshot：读结构化 DOM 快照（可指定框架 / 合并所有框架）。 */
export async function getPageSnapshotTool(deps, args) {
  const ctx = deps.ctx;
  const tabId = ctx.tabId;
  if (!tabId) return { ok: false, result: '无法定位当前标签页（可能不在前台页面）。' };
  // 页面被 JS 对话框阻塞时，快照读不到有效内容，先提示处理对话框。
  if (deps.cdpAllowed(ctx)) {
    const dialogs = deps.getPendingDialogs(tabId);
    if (dialogs.length) {
      const hasPrompt = dialogs.some((d) => d && d.type === 'prompt');
      return {
        ok: true,
        hadEffect: false,
        snapshot: null,
        result:
          '⚠ 页面存在未处理的对话框：' +
          dialogs
            .map((d) => {
              const base = d.type + '：' + d.message;
              // prompt 要把**默认值**一并给出：默认值常常就是要不要保留它的判断依据，
              // 而只 accept 不传 promptText 会原样接受默认值（可能并不是用户要的）。
              return d.type === 'prompt' && d.defaultPrompt !== undefined && d.defaultPrompt !== ''
                ? base + '（默认值："' + d.defaultPrompt + '"）'
                : base;
            })
            .join('；') +
          '\n请先调用 handle_dialog 处理，否则页面被阻塞（在对话框被处理之前，其它操作都不会生效，**不要重复点击**）。' +
          (hasPrompt
            ? '\n这是 prompt：`handle_dialog({accept:true, promptText:"要填入的文本"})` —— ' +
              '**不传 promptText 就会原样接受上面的默认值**，请先确认那是不是你要的。'
            : '\n`handle_dialog({accept:true})` 表示确定，`{accept:false}` 表示取消。'),
      };
    }
  }
  try {
    const explicitFrame = args.frameId !== undefined && args.frameId !== null && args.frameId !== '';
    // 指定 frameId：只读该框架（跨域 iframe 内容也能读，内容脚本已注入所有框架）。
    if (explicitFrame) {
      const fid = Number(args.frameId);
      const snapshot = await deps.getPageSnapshot(tabId, { maxElements: args.maxElements, maxText: args.maxText, frameId: fid });
      if (!snapshot) return { ok: false, result: '未能读取该框架的 DOM 快照（frameId=' + fid + '，可能无内容脚本）。' };
      const tagged = prefixFrameRefs(snapshot, fid);
      return { ok: true, hadEffect: false, snapshot: tagged, result: '框架 ' + fid + ' 的 DOM 快照：\n' + JSON.stringify(tagged) };
    }
    const snapshot = await deps.getPageSnapshot(tabId, args);
    if (!snapshot) return { ok: false, result: '未能读取 DOM 快照（内容脚本未注入或页面不支持）。' };
    // 正文容器提醒：隐藏广告/推广时若连带隐藏它（或它的祖先），会把文章正文一起藏起来。
    const mainHint =
      snapshot.mainContent && snapshot.mainContent.selector
        ? '\n⚠ 疑似正文容器：' +
          snapshot.mainContent.selector +
          '（约 ' +
          snapshot.mainContent.textLength +
          ' 字）—— 隐藏广告/推广时不要整体隐藏它或其祖先。'
        : '';
    // 元素被**体积预算**裁掉时必须说明，并给出下一步。
    //
    // 为什么：`counts.omittedBySize` 只是个数字 —— 模型看不出"被裁掉的是什么、我该做什么" ✗
    // 实测（日期选择器夹具）：`elements` 按**离视口中心的远近**排序，
    // 视口外的日历格子排在最后、先被裁掉，于是"哪些日子已订满"读不到，
    // 而模型**并不知道自己被裁了**（它只会以为页面上就这些元素）。
    // 这与本仓库的既有纪律一致：状态里必须带上"下一步能做什么"。
    const omittedBySize = Number((snapshot.counts && snapshot.counts.omittedBySize) || 0);
    const omitHint =
      omittedBySize > 0
        ? '\n⚠ 另有 ' +
          omittedBySize +
          ' 个可交互元素因**快照体积预算**未列出（elements 按"离视口中心远近"排序，视口外的排在后面、先被裁）。' +
          '需要它们时：先用 scroll_page 把它滚进视口再读一次，或直接按 selector / role+name 操作（不必先"看到"）。'
        : '';
    // includeFrames：合并所有子框架（含跨域 iframe）的可交互元素，ref 带 f<frameId>: 前缀。
    if (args.includeFrames === true) {
      const maxElements = Math.min(150, Math.max(1, Number(args.maxElements) || 60));
      let elements = (snapshot.elements || []).slice();
      const frames = await listFramesRaw(deps, tabId);
      const childFrames = frames.filter((f) => Number(f.frameId) !== 0);
      for (const f of childFrames) {
        if (elements.length >= maxElements) break;
        const s = await deps.getPageSnapshot(tabId, { maxElements: Math.max(1, maxElements - elements.length), maxText: 0, frameId: f.frameId }).catch(() => null);
        if (s && Array.isArray(s.elements) && s.elements.length) {
          elements = elements.concat(prefixFrameRefs(s, f.frameId).elements);
        }
      }
      const capped = elements.slice(0, maxElements);
      // 合并子框架后同样要过体积预算：否则 maxElements 最多 150 个元素一起塞进来，
      // 又会绕开快照本身的 SNAPSHOT_CHAR_BUDGET。
      const trimmed = deps.trimElementsToBudget(capped, String(snapshot.text || '').length);
      const merged = Object.assign({}, snapshot, {
        elements: trimmed.elements,
        counts: Object.assign({}, snapshot.counts, {
          shown: trimmed.elements.length,
          omittedBySize: (snapshot.counts && snapshot.counts.omittedBySize ? snapshot.counts.omittedBySize : 0) + trimmed.omittedBySize,
        }),
        frames: frames.map((f) => ({ frameId: f.frameId, url: f.href, title: f.title, isTop: !!f.isTop })),
      });
      return {
        ok: true,
        hadEffect: false,
        snapshot: merged,
        result:
          '当前页面 DOM 快照（已合并 ' + childFrames.length + ' 个子框架）：\n' + JSON.stringify(merged) +
          '\n提示：带 f<frameId>: 前缀的 ref 属于对应 iframe，动作时直接原样传回 ref 即可。' + mainHint + omitHint,
      };
    }
    return {
      ok: true,
      hadEffect: false,
      snapshot,
      result: '当前页面 DOM 快照：\n' + JSON.stringify(snapshot) + mainHint + omitHint,
    };
  } catch (e) {
    return { ok: false, result: '读取 DOM 快照失败：' + e.message };
  }
}

/** list_frames：列出页面内所有框架及 frameId。 */
export async function listFrames(deps) {
  const tabId = deps.ctx.tabId;
  if (!tabId) return { ok: false, result: '无法定位当前标签页（可能不在前台页面）。' };
  const frames = await listFramesRaw(deps, tabId);
  if (!frames.length) return { ok: false, result: '未获取到页面框架信息（可能无内容脚本权限）。' };
  const text = frames
    .map((f) => (f.isTop ? '[顶层 frameId=0] ' : '[frameId=' + f.frameId + '] ') + (f.title || '') + '｜' + f.href)
    .join('\n');
  return {
    ok: true,
    frames,
    result:
      '页面框架（含跨域 iframe，共 ' + frames.length + ' 个）：\n' + text +
      '\n用法：用 get_page_snapshot 的 frameId 参数读取某框架；或在 get_page_snapshot 里传 includeFrames:true 一次性合并所有框架的元素（ref 会自动带 f<frameId>: 前缀）。',
  };
}

/** 该族处理哪些工具名。 */
export const PAGE_READ_TOOLS = new Set(['read_current_page', 'get_page_snapshot', 'list_frames']);

/** 统一入口。返回 null 表示"不属于本族"。 */
export async function handlePageReadTool(name, args, deps) {
  if (name === 'read_current_page') return await readCurrentPage(deps, args);
  if (name === 'get_page_snapshot') return await getPageSnapshotTool(deps, args);
  if (name === 'list_frames') return await listFrames(deps);
  return null;
}
