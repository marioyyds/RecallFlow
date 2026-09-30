// 会话绑定：把「面板 ↔ 标签页 ↔ 捕获起点」显式绑定起来。
//
// 为什么需要（见 docs/plan-b-dsh-plugin.md §11）：
// 面板是每 tab 一个、会话是全局的，而捕获缓冲（debug-hook 的 console/network）一直是
// **常开但无归属**的 —— 页面信息都是工具「按需」去读，没有"这个会话在讨论哪个页面、
// 从哪一刻开始算"的概念。用户点一下「启动」把这件事显式化：
//   - 绑定的对象（哪个 tab / 哪个 URL）
//   - 捕获起点（点击那一刻的缓冲快照，而不是一个会被环形缓冲挤掉的指针）
//   - 后端（local = 内置 agent；dsh 预留给 DSH 原生插件，见方案 B）
//
// 本模块是**纯逻辑**（无 DOM、无 chrome），因此可在 node 中直测。
// 存储与 UI 分别在 background.js 与 lib/page/chat.js。

export const BINDING_KEY_PREFIX = 'recallflow.binding.';

// 每类缓冲最多快照多少条。缓冲本身上限 150，这里再收一次是为了控制 storage.session 体积。
export const SNAPSHOT_MAX = 50;
// 单条快照里长文本字段的截断长度（console 的 text/stack、network 的 initiator 可能很长）。
export const SNAPSHOT_ENTRY_MAX = 600;

// 后端：'local' 是今天的内置 agent；'dsh' 预留给方案 B（DSH 原生插件），v1 不启用。
export const BINDING_BACKENDS = Object.freeze(['local', 'dsh']);

/**
 * 取缓冲末尾若干条作为快照。
 *
 * 关键：**如实记录丢了多少条**。环形缓冲上限 150，会话起点若只是个指针，
 * 在话痨页面上最早的记录会被静默挤掉 —— 而那恰恰是"刚点启动时发生了什么"。
 * 快照 + dropped 计数让"截断"这件事可见，而不是悄悄少数据。
 */
export function snapshotBuffer(entries, max = SNAPSHOT_MAX) {
  const list = Array.isArray(entries) ? entries : [];
  // 上限语义（fail-closed）：合法的非负数就用它（0 = 一条不留）；
  // 负数钳到 0 —— 而不是退回默认上限。否则调用方算出 max = limit - used < 0 这种
  // 荒谬上限时，反而会灌进 50 条，与"少留数据"的意图正好相反。
  // 真正非数字（NaN/undefined/字符串）才退回默认。
  const n = Number(max);
  const cap = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : SNAPSHOT_MAX;
  const total = list.length;
  const kept = cap > 0 ? list.slice(Math.max(0, total - cap)) : [];
  return {
    total,
    kept: kept.length,
    dropped: total - kept.length,
    entries: kept.map((e) => trimSnapshotEntry(e)),
  };
}

/** 截断单条快照里的长文本字段，保留其余结构（存储体积可控，且不改变语义）。 */
export function trimSnapshotEntry(entry, maxText = SNAPSHOT_ENTRY_MAX) {
  if (!entry || typeof entry !== 'object') return entry;
  const cap = Number.isFinite(Number(maxText)) && Number(maxText) > 0 ? Math.floor(Number(maxText)) : SNAPSHOT_ENTRY_MAX;
  const cut = (v) => {
    if (typeof v !== 'string') return v;
    return v.length > cap ? v.slice(0, cap) + '…（已截断）' : v;
  };
  const out = {};
  for (const k of Object.keys(entry)) out[k] = cut(entry[k]);
  return out;
}

/**
 * 建立一条绑定记录。纯函数：时间与 id 由调用方注入，便于测试。
 * @returns 绑定记录（永不抛错；脏输入被规整为安全值）
 */
export function createBinding(input = {}) {
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : 0;
  const tabId = Number.isFinite(Number(input.tabId)) ? Number(input.tabId) : null;
  const backend = BINDING_BACKENDS.includes(input.backend) ? input.backend : 'local';
  return {
    id: String(input.id || 'sb-' + now + '-' + Math.random().toString(36).slice(2, 8)),
    tabId,
    backend,
    startedAt: now,
    startUrl: String(input.url || ''),
    startTitle: String(input.title || ''),
    console: snapshotBuffer(input.console),
    network: snapshotBuffer(input.network),
    endedAt: null,
    endReason: null,
  };
}

/** 存储回读时的校验与规整：不认识的结构一律返回 null，避免拿半个记录去渲染。 */
export function normalizeBinding(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!raw.id || typeof raw.id !== 'string') return null;
  const startsAt = Number(raw.startedAt);
  if (!Number.isFinite(startsAt)) return null;
  const snap = (v) => (v && typeof v === 'object' && Array.isArray(v.entries) ? v : { total: 0, kept: 0, dropped: 0, entries: [] });
  return {
    id: raw.id,
    tabId: Number.isFinite(Number(raw.tabId)) ? Number(raw.tabId) : null,
    backend: BINDING_BACKENDS.includes(raw.backend) ? raw.backend : 'local',
    startedAt: startsAt,
    startUrl: String(raw.startUrl || ''),
    startTitle: String(raw.startTitle || ''),
    console: snap(raw.console),
    network: snap(raw.network),
    endedAt: Number.isFinite(Number(raw.endedAt)) ? Number(raw.endedAt) : null,
    endReason: raw.endReason ? String(raw.endReason) : null,
  };
}

export function isValidBinding(b) {
  return Boolean(b && typeof b === 'object' && b.id && Number.isFinite(Number(b.startedAt)) && !b.endedAt);
}

/** 规格化 URL 以便比较：去尾部斜杠、去 hash。查询串保留（?id=1 与 ?id=2 是不同页面状态）。 */
export function normalizeUrlForCompare(url) {
  let s = String(url || '').trim();
  if (!s) return '';
  const hashAt = s.indexOf('#');
  if (hashAt >= 0) s = s.slice(0, hashAt);
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/**
 * 页面是否已经漂移（讨论中的 URL 与当前不一致）。
 * 这是修一个既有缺陷：会话按 tab 存活，但 SPA 跳转后面板不会发现页面已经换了。
 */
export function bindingUrlChanged(binding, currentUrl) {
  if (!isValidBinding(binding)) return false;
  const start = normalizeUrlForCompare(binding.startUrl);
  const cur = normalizeUrlForCompare(currentUrl);
  if (!start || !cur) return false;
  return start !== cur;
}

/**
 * 状态文案（纯函数，面板只负责渲染 text 与按 state 加 class）。
 * @returns {{state:'none'|'ok'|'drifted'|'ended', text:string, title:string}}
 */
export function describeBinding(binding, currentUrl, opts = {}) {
  const b = normalizeBinding(binding);
  if (!b) return { state: 'none', text: '▶ 启动', title: '开始一个绑定到当前页面的会话（记录页面与运行时捕获起点）' };
  if (b.endedAt) return { state: 'ended', text: '▶ 重新启动', title: '上次会话已结束：' + (b.endReason || '未说明') };
  const elapsed = describeElapsed(b.startedAt, opts.now);
  const snap = summarizeSnapshot(b);
  if (bindingUrlChanged(b, currentUrl)) {
    return {
      state: 'drifted',
      text: '⚠ 页面已变化',
      title: '会话开始时是 ' + b.startUrl + '，现在是 ' + String(currentUrl || '') + '。点击结束或重新启动。',
    };
  }
  return {
    state: 'ok',
    text: '● 已绑定' + (elapsed ? ' ' + elapsed : ''),
    title: '讨论中：' + (b.startTitle || b.startUrl || '(未记录)') + '\n起点快照：' + snap + '\n后端：' + b.backend,
  };
}

/** 人类可读的已绑定时长（粗粒度即可，避免每秒重渲染）。 */
export function describeElapsed(startedAt, now) {
  const s = Number(startedAt);
  const n = Number.isFinite(Number(now)) ? Number(now) : 0;
  if (!Number.isFinite(s) || !n || n < s) return '';
  const sec = Math.floor((n - s) / 1000);
  if (sec < 60) return sec + ' 秒';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + ' 分钟';
  return Math.floor(min / 60) + ' 小时';
}

/** 快照摘要，供状态提示显示（并如实标出被截断的条数）。 */
export function summarizeSnapshot(binding) {
  const b = normalizeBinding(binding);
  if (!b) return '（无）';
  const part = (label, s) => label + ' ' + s.kept + ' 条' + (s.dropped > 0 ? '（截断 ' + s.dropped + '）' : '');
  return part('console', b.console) + ' / ' + part('network', b.network);
}

/** 结束绑定：返回新记录（不改入参），保留起点信息以便回看。 */
export function endBinding(binding, reason, now) {
  const b = normalizeBinding(binding);
  if (!b) return null;
  return Object.assign({}, b, {
    endedAt: Number.isFinite(Number(now)) ? Number(now) : b.startedAt,
    endReason: String(reason || '用户结束'),
  });
}

/** 存储键：延续 recallflow.conv.<tabId> 的既有约定，按 tab 隔离。 */
export function bindingKey(tabId) {
  return BINDING_KEY_PREFIX + String(tabId);
}
