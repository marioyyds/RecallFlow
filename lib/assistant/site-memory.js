// 站点记忆：按域名记住「成功定位过」的元素选择器与语义，减少重复探索。
// 数据存 chrome.storage.local（仅本地），按命中次数排序，用于在系统提示中给出本站点提示。
const KEY = 'recallflow.siteMemory.v1';
const MAX_PER_ORIGIN = 60;
const MAX_ORIGINS = 50;

function originOf(url) {
  try {
    return new URL(String(url || '')).origin;
  } catch (e) {
    return '';
  }
}

async function readAll() {
  try {
    const d = await chrome.storage.local.get(KEY);
    const m = d && d[KEY];
    return m && typeof m === 'object' ? m : {};
  } catch (e) {
    return {};
  }
}

async function writeAll(all) {
  try {
    await chrome.storage.local.set({ [KEY]: all });
  } catch (e) {}
}

function normalizeKey(label, role, tag) {
  const l = String(label || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 40);
  if (!l) return '';
  return (role || tag || 'el') + '::' + l;
}

function latestTs(site) {
  let ts = 0;
  for (const v of Object.values(site || {})) ts = Math.max(ts, Number(v && v.updatedAt) || 0);
  return ts;
}

// 记住一个成功定位的元素（同 origin 内按 语义 key 去重，累计命中次数）。
export async function rememberElement(url, info) {
  const origin = originOf(url);
  if (!origin || !info || !info.selector) return;
  const key = normalizeKey(info.label, info.role, info.tag);
  if (!key) return;
  const all = await readAll();
  const site = all[origin] || {};
  const prev = site[key];
  site[key] = {
    selector: String(info.selector).slice(0, 300),
    label: String(info.label || '').slice(0, 60),
    role: info.role || '',
    tag: info.tag || '',
    hits: (Number(prev && prev.hits) || 0) + 1,
    updatedAt: Date.now(),
  };
  const trimmed = Object.entries(site)
    .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
    .slice(0, MAX_PER_ORIGIN);
  all[origin] = Object.fromEntries(trimmed);
  const origins = Object.entries(all)
    .sort((a, b) => latestTs(b[1]) - latestTs(a[1]))
    .slice(0, MAX_ORIGINS);
  await writeAll(Object.fromEntries(origins));
}

// 取某 URL 对应站点的记忆提示（按命中次数优先）。
export async function getSiteHints(url, limit = 12) {
  const origin = originOf(url);
  if (!origin) return [];
  const all = await readAll();
  const site = all[origin];
  if (!site) return [];
  return Object.values(site)
    .sort((a, b) => (Number(b.hits) || 0) - (Number(a.hits) || 0) || (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, limit);
}

export async function clearSiteMemory(url) {
  const all = await readAll();
  if (url) {
    const origin = originOf(url);
    if (origin && all[origin]) {
      delete all[origin];
      await writeAll(all);
    }
    return;
  }
  await writeAll({});
}

export { KEY as SITE_MEMORY_KEY };
