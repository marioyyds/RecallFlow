// 宏（可回放的动作序列）存储：把一次成功的多步操作按域名保存，之后无需 LLM 往返即可回放。
// 步骤只保存可稳定重放的字段（selector / text / key / url 等），不含易失的 ref。
const KEY = 'recallflow.macros.v1';
const MAX_PER_ORIGIN = 20;
const MAX_ORIGINS = 50;
const MAX_STEPS = 40;

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

function latestTs(site) {
  let ts = 0;
  for (const v of Object.values(site || {})) ts = Math.max(ts, Number(v && v.updatedAt) || 0);
  return ts;
}

function normalizeName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
}

function sanitizeSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps
    .filter((s) => s && typeof s.tool === 'string' && s.args && typeof s.args === 'object')
    .slice(0, MAX_STEPS)
    .map((s) => ({ tool: s.tool, args: s.args }));
}

export async function saveMacro(url, macro) {
  const origin = originOf(url);
  if (!origin) return null;
  const name = normalizeName(macro && macro.name);
  if (!name) return null;
  const steps = sanitizeSteps(macro && macro.steps);
  if (!steps.length) return null;
  const all = await readAll();
  const site = all[origin] || {};
  const prev = site[name];
  site[name] = {
    name,
    description: String((macro && macro.description) || '').slice(0, 200),
    steps,
    hits: Number(prev && prev.hits) || 0,
    createdAt: (prev && prev.createdAt) || Date.now(),
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
  return site[name];
}

export async function listMacros(url) {
  const origin = originOf(url);
  if (!origin) return [];
  const all = await readAll();
  const site = all[origin];
  if (!site) return [];
  return Object.values(site).sort((a, b) => (b.hits || 0) - (a.hits || 0) || (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function getMacro(url, name) {
  const origin = originOf(url);
  if (!origin) return null;
  const all = await readAll();
  const site = all[origin];
  if (!site) return null;
  return site[normalizeName(name)] || null;
}

export async function bumpMacroHits(url, name) {
  const origin = originOf(url);
  if (!origin) return;
  const all = await readAll();
  const site = all[origin];
  if (!site || !site[normalizeName(name)]) return;
  site[normalizeName(name)].hits = (Number(site[normalizeName(name)].hits) || 0) + 1;
  site[normalizeName(name)].updatedAt = Date.now();
  await writeAll(all);
}

export async function deleteMacro(url, name) {
  const origin = originOf(url);
  if (!origin) return false;
  const all = await readAll();
  const site = all[origin];
  if (!site) return false;
  const key = normalizeName(name);
  if (!site[key]) return false;
  delete site[key];
  await writeAll(all);
  return true;
}

export { KEY as MACRO_KEY };
