// 交接包存储：chrome.storage.local 的读写与容量治理。
//
// 为什么放 storage.local 而不是 storage.session：会话级存储会在浏览器重启后清空，
// 且按 tabId 索引（tab 一变就找不回）。交接包的用途是「复制标识 → 切到别的工具去读」，
// 必须跨标签页、跨重启都可取，因此用 local，并按「最近 N 份」自动淘汰。
//
// 仅在扩展后台运行；不依赖 window，可用 chrome 桩单测。

import { buildHandoffRecord, updateHandoffIndex, normalizeHandoffId } from './handoff.js';

const KEY_PREFIX = 'recallflow.handoff.';
const INDEX_KEY = 'recallflow.handoffIndex';
const MAX_RECORDS = 30;

function area() {
  if (typeof chrome === 'undefined' || !chrome.storage) return null;
  return chrome.storage.local || null;
}

/** 保存（或覆盖）一份交接包；返回 { ok, id, updatedAt, dropped }。 */
export async function saveHandoff(input) {
  const a = area();
  if (!a) return { ok: false, error: '本地存储不可用' };
  let record;
  try {
    record = buildHandoffRecord(input);
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
  const key = KEY_PREFIX + record.id;
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
    await a.set({ [key]: record, [INDEX_KEY]: nextIndex });
  } catch (e) {
    return { ok: false, error: '写入失败：' + ((e && e.message) || String(e)) };
  }
  // 超出上限的旧记录连带删除，避免无限增长。
  if (dropped.length) {
    try {
      await a.remove(dropped.map((id) => KEY_PREFIX + id));
    } catch (e) {
      /* 清理失败不影响本次保存 */
    }
  }
  return { ok: true, id: record.id, updatedAt: record.updatedAt, dropped };
}

/** 按标识读取交接包。 */
export async function getHandoff(id) {
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
  return { ok: true, record: rec };
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

export { KEY_PREFIX, INDEX_KEY, MAX_RECORDS };
