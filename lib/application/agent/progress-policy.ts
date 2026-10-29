// Tool result progress detection used by liveness and loop guards.
// 工具结果是否产生“可观察进展”：新标签页绑定、页面内容/URL 变化、等待匹配成功等。
// 有进展时应重置重复工具计数，避免“新页面后的第一次快照”被误判为重复调用。
function toolResultProgress(res: any) {
  if (!res || typeof res !== 'object') return false;
  if (Number.isInteger(Number(res.targetTabId))) return true;
  if (res.hadEffect === true || res.matched === true || res.satisfied === true) return true;
  const v = res.verification;
  if (v && (v.changed || v.urlChanged || v.contentChanged || v.responseSatisfied)) return true;
  return false;
}

// 结果指纹变化：只读/网络工具有实质新产出（内容长度或首尾片段变化）也算进展，
// 修复 web_search / search_knowledge_base / read_current_page 等「字段不匹配」被误判无进展的问题。
// 仅在执行成功时参与，失败重试（错误文案各异）不误判为进展。
function resultProgressByChange(store: any, name: string, res: any) {
  if (!res || res.ok === false) return false;
  const text = typeof res.result === 'string' ? res.result : '';
  if (!text) return false;
  const fp =
    (Number.isInteger(Number(res.targetTabId)) ? Number(res.targetTabId) : '') +
    '|' + (res.url || '') + '|' + (res.title || '') + '|' + text.length +
    '|' + text.slice(0, 200) + text.slice(-200);
  const prev = store.get(name);
  store.set(name, fp);
  return prev !== undefined && prev !== fp;
}

export { resultProgressByChange, toolResultProgress };
