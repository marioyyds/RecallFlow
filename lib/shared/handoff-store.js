// 交接包存储：chrome.storage.local 的读写与容量治理。
//
// 为什么放 storage.local 而不是 storage.session：会话级存储会在浏览器重启后清空，
// 且按 tabId 索引（tab 一变就找不回）。交接包的用途是「复制标识 → 切到别的工具去读」，
// 必须跨标签页、跨重启都可取，因此用 local，并按「最近 N 份」自动淘汰。
//
// 仅在扩展后台运行；不依赖 window，可用 chrome 桩单测。

import { buildHandoffRecord, buildToolTrail, prepareHandoffTrail, updateHandoffIndex, normalizeHandoffId, fitRecordToBudget } from './handoff.js';

const KEY_PREFIX = 'recallflow.handoff.';
// 全量轨迹单独存一个 key：它有自己的预算，不与记录的 160KB 抢空间（见 prepareHandoffTrail 的说明）。
const TRAIL_KEY_PREFIX = 'recallflow.handoffTrail.';
const INDEX_KEY = 'recallflow.handoffIndex';
const MAX_RECORDS = 30;

function area() {
  if (typeof chrome === 'undefined' || !chrome.storage) return null;
  return chrome.storage.local || null;
}

/** 保存（或覆盖）一份交接包；返回 { ok, id, updatedAt, dropped }。
 *
 * `input` 有两种真实形态：**原始输入**（messages / toolTrail …）或**已经建好的 record**
 * （面板现在就是发 record：`background.js` 直接 `saveHandoff(msg.record)`）。
 * `extras.trailItems` 是**完整轨迹**（面板用 `prepareHandoffTrail(buildToolTrail(msgs)).items` 得到）。
 */
export async function saveHandoff(input, extras = {}) {
  const a = area();
  if (!a) return { ok: false, error: '本地存储不可用' };
  // ⚠ 上一版对"已经是 record"的入参也**再建一次** ⇒ 从 record 里那份**摘要**
  //   （`toolTrail` 只留最近 MAX_TOOL_TRAIL 步）重算"全量" ✗ ⇒ 完整轨迹**从来到不了这里**，
  //   `trailTotal` 变成摘要长度 —— "存全量"整体失效。⇒ 已是 record 就直接用，不再重建。
  const isRecord = !!input && typeof input.id === 'string' && input.trailTotal !== undefined;
  let record;
  try {
    record = isRecord ? input : buildHandoffRecord(input);
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
  // 按字节预算收缩：条数上限（30 条）挡不住单条超长，而 chrome.storage.local
  // 默认配额约 10MB 由所有记录共享。收缩结果里带 truncated 标记，便于排查「内容为何变短」。
  //
  // ⚠ 收缩**只影响随包交付的摘要**，不影响可检索性：完整轨迹另存独立 key（下面那步）。
  const fitted = fitRecordToBudget(record);
  record = fitted.record;
  const key = KEY_PREFIX + record.id;
  // 完整轨迹：与 buildHandoffRecord 内部用**同一个** prepareHandoffTrail，
  // 所以记录里的 trailTotal / trailStored / trailOmitted 与实际存的东西必然自洽。
  // 完整轨迹的**优先来源**：调用方显式带来的 `extras.trailItems`（面板会把全量那份一起发过来）
  // ⇒ 这才让"独立 key 存全量、记录里只交摘要"真正成立 ✓
  // 没有它时退回旧行为：原始输入形态能自己算，**record 形态只能拿到摘要**（那正是上一版的病根）。
  const rawTrail = Array.isArray(extras.trailItems)
    ? extras.trailItems
    : Array.isArray(input.toolTrail)
      ? input.toolTrail
      : buildToolTrail(input.messages);
  const prepared = prepareHandoffTrail(rawTrail);
  let prev = null;
  try {
    const existing = await a.get(key);
    prev = existing && existing[key];
  } catch (e) {
    prev = null;
  }
  // 保留首次创建时间：同一会话多次快照时，createdAt 表示「这次会话是什么时候开始的」。
  if (prev && prev.createdAt) record.createdAt = prev.createdAt;

  let index = [];
  try {
    const data = await a.get(INDEX_KEY);
    index = (data && data[INDEX_KEY]) || [];
  } catch (e) {
    index = [];
  }
  const { index: nextIndex, dropped } = updateHandoffIndex(index, record.id, record.updatedAt, MAX_RECORDS);

  try {
    await a.set({ [key]: record, [TRAIL_KEY_PREFIX + record.id]: prepared.items, [INDEX_KEY]: nextIndex });
  } catch (e) {
    return { ok: false, error: '写入失败：' + ((e && e.message) || String(e)) };
  }
  // 超出上限的旧记录**连同它的轨迹 key 一起删**：
  // 只删记录会留下无主的轨迹（再也取不到，却一直占着配额），30 条一轮就攒出几 MB 垃圾。
  if (dropped.length) {
    try {
      await a.remove(dropped.map((id) => KEY_PREFIX + id).concat(dropped.map((id) => TRAIL_KEY_PREFIX + id)));
    } catch (e) {
      /* 清理失败不影响本次保存 */
    }
  }
  return { ok: true, id: record.id, updatedAt: record.updatedAt, dropped };
}

/**
 * 按标识读取交接包。
 *
 * 默认返回**记录**（含最近若干步轨迹摘要）。
 * 带 `trailFrom` / `trailTo` 时改为返回**完整轨迹的指定区间** ——
 * 这是"存全量、交付按需取"的取回端：接手方看到 `trailStored > toolTrail.length`
 * 就知道"还有更早的探索"，再按区间来取，而不是一次把几百步全灌进上下文。
 */
export async function getHandoff(id, opts = {}) {
  const norm = normalizeHandoffId(id);
  if (!norm) {
    return { ok: false, error: '会话标识无效：' + JSON.stringify(String(id)) + '（应形如 RF-7K2M9X）' };
  }
  const a = area();
  if (!a) return { ok: false, error: '本地存储不可用' };
  const key = KEY_PREFIX + norm;
  let rec = null;
  try {
    const data = await a.get(key);
    rec = data && data[key];
  } catch (e) {
    return { ok: false, error: '读取失败：' + ((e && e.message) || String(e)) };
  }
  if (!rec) {
    return {
      ok: false,
      notFound: true,
      error: '未找到会话 ' + norm + '。可能原因：标识抄错、该记录已被更新的会话挤出（最多保留 ' + MAX_RECORDS + ' 份），或标识来自另一台浏览器/另一个用户配置。',
    };
  }

  const wantsTrail = Number.isFinite(Number(opts.trailFrom)) || Number.isFinite(Number(opts.trailTo));
  if (!wantsTrail) return { ok: true, record: rec };

  const trailKey = TRAIL_KEY_PREFIX + norm;
  let all = [];
  try {
    const data = await a.get(trailKey);
    all = (data && data[trailKey]) || [];
  } catch (e) {
    return { ok: false, error: '读取完整轨迹失败：' + ((e && e.message) || String(e)) };
  }
  const total = Number(rec.trailTotal) || all.length;
  const start = Number.isFinite(Number(opts.trailFrom)) ? Math.max(0, Math.floor(Number(opts.trailFrom))) : 0;
  // `trailTo` 是**开区间上界**（与 slice 一致），并夹到实际长度内
  const end = Number.isFinite(Number(opts.trailTo)) ? Math.min(all.length, Math.floor(Number(opts.trailTo))) : all.length;
  const slice = all.slice(start, Math.max(start, end));
  const textClamped = Number(rec.trailTextClamped) || 0;
  return {
    ok: true,
    trail: slice,
    trailFrom: start,
    trailTo: start + slice.length,
    trailStored: all.length,
    trailTotal: total,
    trailOmitted: Number(rec.trailOmitted) || 0,
    // ★ 取回的步里**单步文本被裁**的有多少步（步在、原文不在）—— 必须与 trailOmitted 一起报，
    //   否则接手方会把"没被 omitted"当成"完整原文" ✗（本仓库硬纪律：丢东西必须说明）
    trailTextClamped: textClamped,
    note:
      (slice.length
        ? '这是完整轨迹的第 ' + start + '–' + (start + slice.length - 1) + ' 步（可检索共 ' + all.length + ' 步）。需要更早的步骤就继续用 trailFrom/trailTo 取。'
        : '该区间没有内容（可检索共 ' + all.length + ' 步，trailTo 是开区间上界）。') +
      (textClamped
        ? ' ⚠ 其中 ' + textClamped + ' 步的 **args/result 文本被裁短**过（步骤在、原文不在，取不回完整原文）。'
        : ''),
  };
}

/** 列出最近的交接包（仅标识与时间，便于 agent 询问「最近有哪些会话」）。 */
export async function listHandoffs(limit = 20) {
  const a = area();
  if (!a) return { ok: false, error: '本地存储不可用', list: [] };
  let index = [];
  try {
    const data = await a.get(INDEX_KEY);
    index = (data && data[INDEX_KEY]) || [];
  } catch (e) {
    return { ok: false, error: '读取失败：' + ((e && e.message) || String(e)), list: [] };
  }
  const n = Number(limit) > 0 ? Math.min(50, Math.floor(Number(limit))) : 20;
  return { ok: true, list: index.slice(0, n).map((e) => ({ id: e.id, at: e.at })) };
}

export { KEY_PREFIX, TRAIL_KEY_PREFIX, INDEX_KEY, MAX_RECORDS };
