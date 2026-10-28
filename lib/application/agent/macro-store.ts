// 宏（可回放的动作序列）存储：把一次成功的多步操作按域名保存，之后无需 LLM 往返即可回放。
// 步骤只保存可稳定重放的字段（selector / text / key / url 等），不含易失的 ref。
import { siteKeyOf } from '../../shared/url.ts';
const KEY = 'recallflow.macros.v1';
const MAX_PER_ORIGIN = 20;
const MAX_ORIGINS = 50;
const MAX_STEPS = 40;

// 站点键与站点记忆同一套规则（本地页按目录归组），见 lib/shared/utils.js 的 siteKeyOf。
function originOf(url: string) {
  return siteKeyOf(url);
}

async function readAll() {
  try {
    const d = await chrome.storage.local.get(KEY);
    const m: any = d && d[KEY];
    return m && typeof m === 'object' ? m : {};
  } catch (e) {
    return {};
  }
}

async function writeAll(all: any) {
  try {
    await chrome.storage.local.set({ [KEY]: all });
  } catch (e) {}
}

function latestTs(site: any) {
  let ts = 0;
  for (const v of Object.values(site || {}) as Array<{ updatedAt?: number }>) ts = Math.max(ts, Number(v && v.updatedAt) || 0);
  return ts;
}

function normalizeName(name: string) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
}

function sanitizeSteps(steps: any) {
  if (!Array.isArray(steps)) return [];
  return steps
    .filter((s) => s && typeof s.tool === 'string' && s.args && typeof s.args === 'object')
    .slice(0, MAX_STEPS)
    .map((s) => ({ tool: s.tool, args: s.args }));
}

export async function saveMacro(url: string, macro: any) {
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
  const trimmed = (Object.entries(site) as [string, any][])
    .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
    .slice(0, MAX_PER_ORIGIN);
  all[origin] = Object.fromEntries(trimmed);
  const origins = Object.entries(all)
    .sort((a, b) => latestTs(b[1]) - latestTs(a[1]))
    .slice(0, MAX_ORIGINS);
  await writeAll(Object.fromEntries(origins));
  return site[name];
}

// 次级排序键用 name 字典序而不是 updatedAt：
// 这份列表会拼进**系统提示**（请求前缀的起点）。时间戳做次级键时，
// 命中数相同的宏会随使用重排，每次 run 的系统提示都不一样，跨 run 的前缀缓存永远命中不了。
export async function listMacros(url: string) {
  const origin = originOf(url);
  if (!origin) return [];
  const all = await readAll();
  const site = all[origin];
  if (!site) return [];
  const values: any[] = Object.values(site);
  return values.sort(
    (a, b) => (b.hits || 0) - (a.hits || 0) || String(a.name || '').localeCompare(String(b.name || ''))
  );
}

export async function getMacro(url: string, name: string) {
  const origin = originOf(url);
  if (!origin) return null;
  const all = await readAll();
  const site = all[origin];
  if (!site) return null;
  return site[normalizeName(name)] || null;
}

export async function bumpMacroHits(url: string, name: string) {
  const origin = originOf(url);
  if (!origin) return;
  const all = await readAll();
  const site = all[origin];
  if (!site || !site[normalizeName(name)]) return;
  site[normalizeName(name)].hits = (Number(site[normalizeName(name)].hits) || 0) + 1;
  site[normalizeName(name)].updatedAt = Date.now();
  await writeAll(all);
}

export async function deleteMacro(url: string, name: string) {
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

// ---------------------------------------------------------------------------
// 跨轮次的「最近一次可重放轨迹」：让宏能隔一轮再沉淀。
//
// 为什么需要：`ctx.trace` 只活在**一次运行**里（agent.js 每次 run 都新建空数组），
// 而用户说「把这个流程存成宏 / 沉淀下来」常常发生在**下一轮对话**。
// 实测会话 RF-FY6PUP：发布 3 条小红书笔记的流程跑完之后，用户下一轮才说「沉淀为技能」，
// 此时 trace 已随上一轮一起消失 ⇒ op=save 只能回「当前任务没有可保存的可重放动作」，
// 而它几分钟前刚把整套流程做过一遍 —— 用户看到的却是"不能保存宏"。
//
// 记录时机：每**真的**记下一步时顺手写一次（见 tools.js 的 recordTraceStep）。
// 这不是"每次工具调用都写"：只有白名单内**且拿得到稳定 selector** 的步骤才会走到那里，
// 一次任务通常十几步；而 agent.js 本来就在**每个工具调用后**持久化整份会话（含全部消息），
// 所以这点写入远小于既有开销。
//
// 与宏本体的区别：这里是**按 origin 单槽覆盖**的暂存（只留最近一次）+ TTL。
// 过期的轨迹比没有轨迹更危险 —— 拿半小时前的操作序列去回放，等于在一个已经变了的页面上乱点。
// 存 `local`（不是 `session`）：用途就是"跨任务取回"，而 session 在浏览器重启后会清空。
// ---------------------------------------------------------------------------
const LAST_TRACE_KEY = 'recallflow.lastTrace.v1';
export const LAST_TRACE_TTL_MS = 30 * 60 * 1000;
// 与 MAX_STEPS 同值：存不进宏的步骤，记住它没有意义。
const MAX_REMEMBERED_STEPS = MAX_STEPS;

async function readLastTraces() {
  try {
    const d = await chrome.storage.local.get(LAST_TRACE_KEY);
    const m: any = d && d[LAST_TRACE_KEY];
    return m && typeof m === 'object' ? m : {};
  } catch (e) {
    return {};
  }
}

async function writeLastTraces(all: any) {
  try {
    await chrome.storage.local.set({ [LAST_TRACE_KEY]: all });
  } catch (e) {}
}

/** 暂存本轮的可重放轨迹（按 origin 单槽覆盖）。返回写入的记录；没写时返回 null。 */
export async function rememberTrace(url: string, steps: any) {
  const origin = originOf(url);
  if (!origin) return null;
  // 用与宏本体**同一份** sanitizeSteps：保证"能记住的"与"能存进宏的"形状一致，
  // 否则会出现"记住了却存不进去"的静默丢失（本仓库硬纪律：丢东西必须说明）。
  const clean = sanitizeSteps(steps);
  if (!clean.length) return null;
  const all = await readLastTraces();
  const rec = {
    steps: clean.slice(0, MAX_REMEMBERED_STEPS),
    updatedAt: Date.now(),
    // 被裁掉的步数要留着：取回时若 >0，必须如实告知"轨迹不完整"。
    dropped: Math.max(0, clean.length - MAX_REMEMBERED_STEPS),
  };
  all[origin] = rec;
  const origins = (Object.entries(all) as [string, any][])
    .sort((a, b) => Number((b[1] && b[1].updatedAt) || 0) - Number((a[1] && a[1].updatedAt) || 0))
    .slice(0, MAX_ORIGINS);
  await writeLastTraces(Object.fromEntries(origins));
  return rec;
}

/** 取回某站点最近一次的可重放轨迹；超过 TTL 一律当作没有。 */
export async function recallTrace(url: string, opts: Record<string, any> = {}) {
  const origin = originOf(url);
  if (!origin) return null;
  const maxAgeMs = Number.isFinite(Number(opts.maxAgeMs)) ? Number(opts.maxAgeMs) : LAST_TRACE_TTL_MS;
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const all = await readLastTraces();
  const rec = all[origin];
  if (!rec || !Array.isArray(rec.steps) || !rec.steps.length) return null;
  const ageMs = Math.max(0, now - Number(rec.updatedAt || 0));
  // 用 `>=` 而不是 `>`：这样 `maxAgeMs: 0` 的含义就是"什么都不算新鲜"（可测的边界），
  // 而不是"刚写的也永远算新鲜"。
  if (ageMs >= maxAgeMs) return null;
  return { steps: rec.steps, updatedAt: Number(rec.updatedAt) || 0, ageMs, dropped: Number(rec.dropped) || 0 };
}

export { KEY as MACRO_KEY, LAST_TRACE_KEY };
