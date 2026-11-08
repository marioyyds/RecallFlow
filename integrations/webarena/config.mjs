// WebArena 评测编排的**纯参数/任务选择逻辑**（零依赖，便于单测）。
//
// 为什么把它从 run.mjs 里拆出来：run.mjs 顶部要动态 import Playwright（重、且需要浏览器二进制），
// 若把参数解析写在里面，单测就得付出启动成本，甚至因为环境缺失而跑不了 ——
// 于是"最容易写错的一段"（参数默认值、任务选择）反而没人测。

// read 永远允许（可不写）；其余是开工前可声明的风险类别。high 不在此列（任何声明都换不到）。
const RISK_CATEGORIES = ['read', 'page', 'browser', 'network', 'write', 'destructive', 'external'];

/** 解析 CLI 参数。未知参数抛错（静默忽略一个拼错的 flag 会让人以为"它在按你说的跑"）。 */
export function parseArgs(argv) {
  const out = {
    tasks: '',
    out: '',
    taskIds: [],
    sites: [],
    limit: 0,
    allowRisk: ['read', 'page', 'write', 'browser', 'network'],
    siteUrls: {},
    headers: {},
    pollMs: 500,
    timeoutMs: 300000,
    concurrency: 3,
    siteReset: 'per-task',
    resetWaitMs: 180000,
    actionRetries: 1,
    taskFormat: 'verified',
    imageSet: 'verified',
    captureHar: true,
    dryRun: false,
    profileDir: '',
    extPath: '',
    resume: false,
    help: false,
  };
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const next = () => {
      const v = list[i + 1];
      if (v === undefined) throw new Error(a + ' 需要一个值');
      i += 1;
      return v;
    };
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--no-har') out.captureHar = false;
    else if (a === '--resume') out.resume = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--tasks') out.tasks = next();
    else if (a === '--out') out.out = next();
    else if (a === '--profile-dir') out.profileDir = next();
    else if (a === '--ext') out.extPath = next();
    else if (a === '--sites') out.sites = next().split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    else if (a === '--task-id') out.taskIds = out.taskIds.concat(next().split(',').map((x) => Number(x.trim())).filter(Number.isInteger));
    else if (a === '--limit') out.limit = Number(next());
    else if (a === '--poll-ms') out.pollMs = Number(next());
    else if (a === '--timeout-ms') out.timeoutMs = Number(next());
    else if (a === '--concurrency') out.concurrency = Number(next());
    else if (a === '--site-reset') {
      const mode = next().trim().toLowerCase();
      if (!['none', 'run', 'per-task'].includes(mode)) {
        throw new Error('--site-reset 只接受 none / run / per-task');
      }
      out.siteReset = mode;
    }
    else if (a === '--reset-wait-ms') out.resetWaitMs = Number(next());
    else if (a === '--action-retries') out.actionRetries = Number(next());
    else if (a === '--task-format') {
      const format = next().trim().toLowerCase();
      if (!['verified', 'original'].includes(format)) {
        throw new Error('--task-format 只接受 verified / original');
      }
      out.taskFormat = format;
    }
    else if (a === '--image-set') {
      const imageSet = next().trim().toLowerCase();
      if (!['verified', 'original'].includes(imageSet)) {
        throw new Error('--image-set 只接受 verified / original');
      }
      out.imageSet = imageSet;
    }
    else if (a === '--allow-risk') out.allowRisk = next().split(',').map((x) => x.trim()).filter(Boolean);
    else if (a === '--site-url') {
      const raw = next();
      const eq = raw.indexOf('=');
      if (eq <= 0) throw new Error('--site-url 需要 NAME=URL 形式，收到：' + raw);
      out.siteUrls[raw.slice(0, eq).trim().toUpperCase()] = raw.slice(eq + 1).trim();
    }
    else if (a === '--header') {
      const raw = next();
      const i = raw.indexOf(':');
      if (i <= 0) throw new Error('--header 需要 "Name: value" 形式，收到：' + raw);
      out.headers[raw.slice(0, i).trim()] = raw.slice(i + 1).trim();
    }
    else throw new Error('未知参数：' + a + '（用 --help 看用法）');
  }
  if (!Number.isFinite(out.limit) || out.limit < 0) out.limit = 0;
  if (!Number.isFinite(out.pollMs) || out.pollMs < 200) out.pollMs = 500;
  if (!Number.isFinite(out.timeoutMs) || out.timeoutMs < 1000) out.timeoutMs = 300000;
  if (!Number.isInteger(out.concurrency) || out.concurrency < 1) out.concurrency = 3;
  if (out.concurrency > 8) out.concurrency = 8;
  if (!Number.isFinite(out.resetWaitMs) || out.resetWaitMs < 10000) out.resetWaitMs = 180000;
  if (!Number.isInteger(out.actionRetries) || out.actionRetries < 0) out.actionRetries = 1;
  if (out.actionRetries > 2) out.actionRetries = 2;
  return out;
}

/** 校验 allowRisk：含 high 或未知类别直接报错（high 任何声明都换不到）。 */
export function validateAllowRisk(list) {
  const arr = Array.isArray(list) ? list.map((x) => String(x).trim().toLowerCase()).filter(Boolean) : [];
  const bad = arr.filter((x) => !RISK_CATEGORIES.includes(x));
  if (bad.length) {
    throw new Error(
      'allowRisk 含不可声明类别：' + bad.join('、') + '。' +
        '可用：' + RISK_CATEGORIES.join('/') + '（read 永远允许，可不写；high 任何声明都换不到）。'
    );
  }
  return arr;
}

/** 从任务文件内容里取出任务数组，兼容裸数组与 {tasks:[...]} 两种写法。 */
export function loadTasksFromJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error('任务文件不是合法 JSON：' + String((e && e.message) || e));
  }
  const arr = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.tasks) ? parsed.tasks : null;
  if (!arr) throw new Error('任务文件里找不到任务数组（应为 [...] 或 { "tasks": [...] }）');
  return arr;
}

/** 按 --task-id / --sites / --limit 选择任务，**保持原顺序**。 */
export function selectTasks(tasks, { taskIds = [], sites = [], limit = 0 } = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  let picked = list;
  if (taskIds.length) {
    const want = new Set(taskIds);
    picked = picked.filter((t) => want.has(Number(t && (t.task_id !== undefined ? t.task_id : t.taskId))));
  }
  if (sites.length) {
    // only keep tasks whose **every** site is in the allowlist: running a multi-site task
    // with one site unavailable would silently produce a failure unrelated to the agent.
    const allow = new Set(sites.map((s) => String(s).toLowerCase()));
    picked = picked.filter((t) => {
      const ts = Array.isArray(t && t.sites) ? t.sites : [];
      return ts.length === 0 || ts.every((s) => allow.has(String(s).toLowerCase()));
    });
  }
  if (limit > 0) picked = picked.slice(0, limit);
  return picked;
}

/** 任务需要的站点锁；没有站点声明的任务单独串行，避免隐式共享账号。 */
export function taskSiteScope(task) {
  const sites = Array.isArray(task && task.sites)
    ? task.sites.map((site) => String(site || '').trim().toLowerCase()).filter(Boolean)
    : [];
  return [...new Set(sites.length ? sites : ['__unscoped__'])];
}

/**
 * 找第一条与当前活跃站点不冲突的任务。
 *
 * WebArena 每个站点只有一组测试账号；同一站点并发会触发 Magento
 * “terminated by another user”之类的会话互踢。跨站点仍可并发。
 */
export function selectRunnableTaskIndex(tasks, activeSites) {
  const active = activeSites instanceof Set ? activeSites : new Set(activeSites || []);
  return (Array.isArray(tasks) ? tasks : []).findIndex((task) =>
    taskSiteScope(task).every((site) => !active.has(site))
  );
}

/**
 * 把任务 start_urls 里的 `__SITE__` 占位符替换成本地站点地址（WebArena 官方任务用的就是这套占位符）。
 *
 * 返回**新对象**，不改原任务：任务文件是从外部下载的，就地改写会让"同一份数据"
 * 在不同运行间互相污染（尤其是批量跑时）。
 *
 * 未被映射的占位符会被**保留**（并在 run.mjs 里被 detectUnresolvedSites 点出来）——
 * 静默把它们清空会得到一堆空 URL，症状是"任务全在 about:blank 上跑"，很难归因。
 */
export function applySiteUrls(task, map = {}) {
  const t = Object.assign({}, task || {});
  const keys = Object.keys(map || {});
  const raw = task && (task.start_urls !== undefined ? task.start_urls : task.startUrls);
  const urls = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const replaced = urls.map((u) => {
    let s = String(u);
    for (const k of keys) s = s.split('__' + k + '__').join(map[k]);
    return s;
  });
  t.start_urls = replaced;
  delete t.startUrls;
  return t;
}

/** 找出替换后仍残留 `__XXX__` 的站点名（供编排器提示"你漏配了哪个站点"）。 */
export function detectUnresolvedSites(tasks) {
  const found = new Set();
  for (const t of Array.isArray(tasks) ? tasks : []) {
    const raw = t && (t.start_urls !== undefined ? t.start_urls : t.startUrls);
    const urls = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const u of urls) {
      for (const m of String(u).matchAll(/__([A-Z0-9_]+)__/g)) found.add(m[1]);
    }
  }
  return [...found];
}

/**
 * 解析 `user:password` 形式的站点登录凭据。
 * 只按**第一个**冒号切：密码里可以再出现冒号；空用户名/空密码视为未配置。
 */
export function parseLogin(raw) {
  const s = String(raw || '');
  const i = s.indexOf(':');
  if (i <= 0 || i === s.length - 1) return null;
  return { user: s.slice(0, i), password: s.slice(i + 1) };
}

/**
 * 从单任务墙钟上限计算 agent 的软/硬截止时间。
 *
 * 硬截止要早于外部等待（否则外部先把 job kill 掉，留下一个 running 快照）；
 * 软截止只发一次"立即收尾"提醒。纯函数便于直测。
 */
export function deadlineForTask({ timeoutMs = 300000, startedMs = Date.now() } = {}) {
  const t = Number(timeoutMs) > 0 ? Number(timeoutMs) : 300000;
  const s = Number.isFinite(Number(startedMs)) ? Number(startedMs) : Date.now();
  const wrapOffset = Math.max(30000, Math.floor(t * 0.75));
  const deadlineOffset = Math.max(wrapOffset + 10000, t - 30000);
  return { deadlineAt: s + deadlineOffset, wrapUpAt: s + wrapOffset };
}
