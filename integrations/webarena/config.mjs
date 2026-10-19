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
    limit: 0,
    allowRisk: ['read', 'page', 'write', 'browser', 'network'],
    pollMs: 3000,
    timeoutMs: 300000,
    dryRun: false,
    profileDir: '',
    extPath: '',
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
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--tasks') out.tasks = next();
    else if (a === '--out') out.out = next();
    else if (a === '--profile-dir') out.profileDir = next();
    else if (a === '--ext') out.extPath = next();
    else if (a === '--task-id') out.taskIds = out.taskIds.concat(next().split(',').map((x) => Number(x.trim())).filter(Number.isInteger));
    else if (a === '--limit') out.limit = Number(next());
    else if (a === '--poll-ms') out.pollMs = Number(next());
    else if (a === '--timeout-ms') out.timeoutMs = Number(next());
    else if (a === '--allow-risk') out.allowRisk = next().split(',').map((x) => x.trim()).filter(Boolean);
    else throw new Error('未知参数：' + a + '（用 --help 看用法）');
  }
  if (!Number.isFinite(out.limit) || out.limit < 0) out.limit = 0;
  if (!Number.isFinite(out.pollMs) || out.pollMs < 200) out.pollMs = 3000;
  if (!Number.isFinite(out.timeoutMs) || out.timeoutMs < 1000) out.timeoutMs = 300000;
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

/** 按 --task-id / --limit 选择任务，**保持原顺序**。 */
export function selectTasks(tasks, { taskIds = [], limit = 0 } = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  let picked = list;
  if (taskIds.length) {
    const want = new Set(taskIds);
    picked = list.filter((t) => want.has(Number(t && (t.task_id !== undefined ? t.task_id : t.taskId))));
  }
  if (limit > 0) picked = picked.slice(0, limit);
  return picked;
}
