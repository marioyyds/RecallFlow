#!/usr/bin/env node
// WebArena-Verified 评测编排器：把 WebArena 的任务交给 RecallFlow 的真 agent 跑，并落盘可离线评测的产物。
//
// 产物（每条任务一个目录）：
//   agent_response_<id>.json  —— FinalAgentResponse（规范键 task_type/status/retrieved_data/error_details）
//   har_<id>.har              —— 网络 trace（WebArena-Verified 的 network 评测器读它）
//   recallflow_<id>.json      —— 原始 job 终态（state / 答复 / 事件摘要），用于归因
//
// 用法：
//   node integrations/webarena/run.mjs --tasks tasks.json --out out/            # 实跑（需浏览器 + 扩展已配 API Key）
//   node integrations/webarena/run.mjs --tasks tasks.json --dry-run            # 只校验任务 + 打印将发出的指令与终态契约
//   node integrations/webarena/run.mjs --tasks tasks.json --task-id 7,44 --limit 5
//
// 设计取舍：dry-run 与实跑共用同一套「任务 → 指令」路径，所以 dry-run 打印的
// 就是实跑会发的指令 —— 否则"本地校验通过、线上发的却是另一句"。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parseArgs, validateAllowRisk, loadTasksFromJson, selectTasks, applySiteUrls, detectUnresolvedSites, parseLogin, deadlineForTask } from './config.mjs';
import { normalizeTask, buildInstruction, toAgentResponse, validateAgentResponse } from '../../lib/eval/webarena-adapter.mjs';
import { McpBridgeClient } from './mcp-client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MCP_DIR = path.join(ROOT, 'integrations', 'opencode', 'recallflow-mcp');

const HELP = `RecallFlow × WebArena-Verified 评测编排器

用法：node integrations/webarena/run.mjs --tasks <file> [选项]

  --tasks <file>        WebArena 任务 JSON（[...] 或 { "tasks": [...] }）  [实跑必需]
  --out <dir>           产物目录（默认 ./webarena-out）
  --task-id <a,b>       只跑指定 task_id（可重复，逗号分隔）
  --sites <a,b>         只跑 sites 全部落在这些站点内的任务（如 shopping,shopping_admin,reddit）
  --resume              跳过产物目录里已有 agent_response.json 的任务（断点续跑）
  --limit <n>           只跑前 n 条（在 task-id / sites / resume 过滤之后）
  --allow-risk <csv>    开工前声明的风险预算（默认 read,page,write,browser,network；不含 high）
  --site-url N=URL      把任务里的 __N__ 占位符映射到本地站点地址（可重复，如 --site-url SHOPPING=http://localhost:7770）
  --header "N: v"       给浏览器上下文加请求头（可重复；WebArena 站点用头自动登录，如 --header "X-M2-Admin-Auto-Login: admin:admin1234"）
  --poll-ms <n>         轮询间隔（默认 3000）
  --timeout-ms <n>      单任务墙钟上限（默认 300000）
  --profile-dir <dir>   浏览器用户数据目录（默认每条任务用临时目录 = 隔离）
  --ext <path>          扩展根目录（默认仓库根）
  --dry-run             不启浏览器，只校验任务并打印将发出的指令/终态契约
  -h, --help            显示本帮助

需要登录的站点（shopping / reddit）用环境变量提供凭据：
  RECALLFLOW_EVAL_SHOPPING_LOGIN=email:password
  RECALLFLOW_EVAL_REDDIT_LOGIN=username:password
或直接复用登录态（推荐，避免逐任务登录被限流）：
  RECALLFLOW_EVAL_SHOPPING_STATE=shopping-state.json
  RECALLFLOW_EVAL_REDDIT_STATE=reddit-state.json
`;

function readTaskFile(file) {
  if (!file) throw new Error('缺少 --tasks <file>');
  const abs = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
  if (!fs.existsSync(abs)) throw new Error('任务文件不存在：' + abs);
  return loadTasksFromJson(fs.readFileSync(abs, 'utf8'));
}

function taskIdOf(t) {
  return Number(t && (t.task_id !== undefined ? t.task_id : t.taskId));
}

/** dry-run：把「任务 → 指令」的路径完整走一遍，但不碰浏览器。 */
function dryRun(tasks, { allowRisk }) {
  let bad = 0;
  for (const raw of tasks) {
    try {
      const task = normalizeTask(raw);
      const instruction = buildInstruction(task);
      console.log('\n===== task ' + task.taskId + '（期望动作 ' + task.expectedAction + '）=====');
      console.log('起始页：' + task.startUrls[0]);
      console.log('--- 将发给 agent_task 的指令 ---');
      console.log(instruction);
    } catch (e) {
      bad += 1;
      const id = raw && (raw.task_id !== undefined ? raw.task_id : raw.taskId);
      console.error('✖ task ' + id + ' 不合法：' + String((e && e.message) || e));
    }
  }
  console.log(
    '\n[dry-run] 任务 ' + tasks.length + ' 条：' + (tasks.length - bad) + ' 条通过 / ' + bad + ' 条不合法；' +
      'allowRisk=[' + allowRisk.join(',') + ']（high 任何声明都换不到）'
  );
  return bad ? 1 : 0;
}

/** /health 是否像一个活着的桥接服务（有 pid / ws / ok 任一字段）。 */
function looksLikeBridge(h) {
  return Boolean(h && (h.pid || h.ws !== undefined || h.ok !== undefined));
}

/**
 * 复用**已存在**的桥接服务时的告警文案。
 *
 * 为什么必须说：7801 上可能挂着一个两天前启动的常驻实例（报告 4.5 实测遇到过）。
 * 复用它意味着"跑的是那个进程加载的旧代码" —— 本轮代码修复全部不生效，
 * 而现象只是"评测结果没变"，不会报错。静默复用是最容易把结论带偏的一处。
 */
export function describeBridgeReuse(h) {
  if (!looksLikeBridge(h)) return '';
  const pid = h.pid ? 'pid=' + h.pid : 'pid 未知';
  const ws = h.ws ? '扩展已连上' : '扩展未连上';
  return (
    '警告：7801 上已有桥接服务在跑（' + pid + '，' + ws + '），本次将复用它 —— ' +
    '它可能加载的是旧代码（实测遇到过两天前启动的实例）。评测前建议重启该服务，' +
    '否则本轮修复可能不生效且不会报错。'
  );
}

/** 确保 7801 上的桥接服务在跑；不在就拉起一个（先连上的是它，扩展随后自动连）。 */
async function ensureBridgeServer(client) {
  const h = await client.health();
  const reuse = describeBridgeReuse(h);
  if (reuse) {
    console.warn(reuse);
    return null;
  }
  const child = spawn(process.execPath, [path.join(MCP_DIR, 'index.js'), '--http'], {
    cwd: MCP_DIR,
    stdio: 'inherit',
    env: process.env,
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const probe = await client.health();
    if (looksLikeBridge(probe)) return child;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('桥接服务 15s 内没起来（' + path.join(MCP_DIR, 'index.js') + ' --http）');
}

async function runOne({ raw, opts, client, settings, outDir }) {
  const { launchBrowser, configureExtension, closeBrowser, prepareSiteLogin, navigateTabWithHeaders: syncTab } = await import('./harness.mjs');
  const task = normalizeTask(raw);
  const instruction = buildInstruction(task);
  // 目录布局对齐 WebArena-Verified 的 evaluator：它按 `<out>/<task_id>/agent_response.json`
  // 和 `<out>/<task_id>/network.har` 找产物（文件名来自 types/config.py 的默认值）。
  // 用别的布局会得到"0 条可评测任务"，而且那个报错不会告诉你是文件名不对。
  const taskDir = path.join(outDir, String(task.taskId));
  fs.mkdirSync(taskDir, { recursive: true });
  const harPath = path.join(taskDir, 'network.har');
  const startedAt = Date.now();
  let context = null;
  let response;
  let job = null;
  try {
    const states = [];
    if (task.sites.includes('shopping') && opts.shoppingState && fs.existsSync(opts.shoppingState)) states.push(opts.shoppingState);
    if (task.sites.includes('reddit') && opts.redditState && fs.existsSync(opts.redditState)) states.push(opts.redditState);
    context = await launchBrowser({ userDataDir: opts.profileDir || '', harPath, extPath: opts.extPath || undefined, extraHTTPHeaders: opts.headers, storageState: states });
    // 先做会话 preflight，再把墙钟预算写进扩展设置（预算从 agent 真正开工时算）。
    await prepareSiteLogin(context, task.sites, opts.logins || {}, opts.siteUrls || {});
    const timeoutMs = Number(opts.timeoutMs) || 300000;
    const { deadlineAt, wrapUpAt } = deadlineForTask({ timeoutMs, startedMs: Date.now() });
    const taskSettings = Object.assign({}, settings, { deadlineAt, wrapUpAt });
    await configureExtension(context, taskSettings);
    await client.waitForExtension(60000);
    const opened = await client.openTab(task.startUrls[0]);
    if (!opened || opened.ok === false) throw new Error('open_tab 失败：' + JSON.stringify(opened));
    // 扩展开的 tab 不带 context 级请求头：靠头自动登录的站点会让 agent 停在登录页。
    // 先让 Playwright 接管这个 tab 并重新导航，头才会跟上（详见 harness.navigateTabWithHeaders）。
    if (Object.keys(opts.headers || {}).length) {
      const ok = await syncTab(context, task.startUrls[0]);
      if (!ok) process.stdout.write('    ! 未能让 Playwright 接管起始 tab，请求头可能不生效\n');
    }
    const started = await client.startAgentTask({ instruction, allowRisk: opts.allowRisk, tabId: opened.tabId });
    if (!started || started.ok === false) throw new Error('agent_task 启动失败：' + JSON.stringify(started));
    job = await client.waitForJob(started.jobId, {
      pollMs: opts.pollMs,
      timeoutMs: opts.timeoutMs,
      onProgress: (p) => {
        process.stdout.write('    · seq=' + p.seq + ' state=' + p.state + ' omitted=' + (p.omitted || 0) + '\n');
        if (process.env.RECALLFLOW_EVAL_DEBUG) {
          process.stdout.write('      raw=' + JSON.stringify(p.raw).slice(0, 600) + '\n');
        }
      },
    });
    response = toAgentResponse(job.result, { state: job.state, error: job.error, expectedAction: task.expectedAction });
  } catch (e) {
    response = toAgentResponse('', { state: 'failed', error: String((e && e.message) || e), expectedAction: task && task.expectedAction });
    job = Object.assign({ state: 'failed' }, job || {}, { error: String((e && e.message) || e) });
  } finally {
    if (context) await closeBrowser(context);
  }
  const check = validateAgentResponse(response);
  const record = {
    task_id: task.taskId,
    expected_action: task.expectedAction,
    response,
    response_valid: check.ok,
    response_errors: check.errors,
    job_state: job && job.state,
    job_error: (job && job.error) || null,
    // 原样保留 agent 最终答复：解析失败时，唯一能归因的依据就是它
    //（"模型没按契约回答"与"契约没送到模型"是两回事，没有原文就分不清）。
    answer: job && typeof job.result === 'string' ? job.result : null,
    duration_ms: Date.now() - startedAt,
    har: path.basename(harPath),
  };
  fs.writeFileSync(path.join(taskDir, 'agent_response.json'), JSON.stringify(response, null, 2) + '\n');
  fs.writeFileSync(path.join(taskDir, 'recallflow.json'), JSON.stringify(record, null, 2) + '\n');
  const flag = response.status === 'SUCCESS' ? 'OK ' : 'FAIL';
  console.log('  [' + flag + '] task ' + task.taskId + ' → ' + response.status + (check.ok ? '' : '（schema: ' + check.errors.join('；') + '）'));
  return record;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(String((e && e.message) || e));
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }
  let allowRisk;
  let rawTasks;
  try {
    allowRisk = validateAllowRisk(opts.allowRisk);
    rawTasks = readTaskFile(opts.tasks);
  } catch (e) {
    console.error(String((e && e.message) || e));
    process.exit(2);
  }
  const mapped = rawTasks.map((t) => applySiteUrls(t, opts.siteUrls));
  const outDir = path.resolve(process.cwd(), opts.out || 'webarena-out');
  let tasks = selectTasks(mapped, { taskIds: opts.taskIds, sites: opts.sites, limit: 0 });
  if (opts.resume && !opts.dryRun) {
    const before = tasks.length;
    tasks = tasks.filter((t) => !fs.existsSync(path.join(outDir, String(taskIdOf(t)), 'agent_response.json')));
    if (before !== tasks.length) console.log('[resume] 跳过已完成 ' + (before - tasks.length) + ' 条，剩余 ' + tasks.length + ' 条');
  }
  if (opts.limit > 0) tasks = tasks.slice(0, opts.limit);
  const unresolved = detectUnresolvedSites(tasks);
  if (unresolved.length) {
    console.error(
      '警告：选中的任务里还有未解析的站点占位符 ' + unresolved.map((s) => '__' + s + '__').join(', ') +
        '，用 --site-url ' + unresolved[0] + '=http://... 指定（否则任务会落在无效地址上）。'
    );
  }
  if (!tasks.length) {
    console.error('没有选中任何任务（检查 --task-id / 任务文件）。');
    process.exit(2);
  }
  if (opts.dryRun) {
    process.exit(dryRun(tasks, { allowRisk }));
  }

  fs.mkdirSync(outDir, { recursive: true });

  const apiKey = process.env.RECALLFLOW_EVAL_API_KEY || process.env.RECALLFLOW_WEBARENA_API_KEY || '';
  const bridgeToken = process.env.RECALLFLOW_BRIDGE_TOKEN || 'recallflow-local-bridge-v1';
  const client = new McpBridgeClient({
    host: process.env.RECALLFLOW_MCP_HOST || '127.0.0.1',
    port: Number(process.env.RECALLFLOW_MCP_PORT) || 7801,
    token: bridgeToken,
  });
  const settings = (await import('./harness.mjs')).webarenaSettings({
    apiKey,
    baseUrl: process.env.RECALLFLOW_EVAL_BASE_URL || process.env.RECALLFLOW_WEBARENA_BASE_URL,
    model: process.env.RECALLFLOW_EVAL_MODEL || process.env.RECALLFLOW_WEBARENA_MODEL,
    bridgeToken,
  });

  // 需要登录的站点凭据（公开数据集不再带 storage_state；按站点登录一次）。
  // 格式：email:password / username:password；不配就按游客跑（账户类任务会 PERMISSION_DENIED）。
  const logins = {};
  const shopLogin = parseLogin(process.env.RECALLFLOW_EVAL_SHOPPING_LOGIN);
  if (shopLogin) logins.shopping = { baseUrl: opts.siteUrls.SHOPPING || 'http://localhost:7770', email: shopLogin.user, password: shopLogin.password };
  const redditLogin = parseLogin(process.env.RECALLFLOW_EVAL_REDDIT_LOGIN);
  if (redditLogin) logins.reddit = { baseUrl: opts.siteUrls.REDDIT || 'http://localhost:9999', username: redditLogin.user, password: redditLogin.password };
  const shoppingState = process.env.RECALLFLOW_EVAL_SHOPPING_STATE || '';
  const redditState = process.env.RECALLFLOW_EVAL_REDDIT_STATE || '';

  let server = null;
  const records = [];
  try {
    server = await ensureBridgeServer(client);
    await client.connect();
    console.log('桥接就绪，开始跑 ' + tasks.length + ' 条任务 → ' + outDir);
    for (const raw of tasks) {
      process.stdout.write('\n▶ task ' + (raw && (raw.task_id !== undefined ? raw.task_id : raw.taskId)) + '\n');
      records.push(await runOne({ raw, opts: Object.assign({}, opts, { allowRisk, logins, shoppingState, redditState }), client, settings, outDir }));
    }
  } finally {
    if (server) server.kill();
  }
  const okCount = records.filter((r) => r.response.status === 'SUCCESS').length;
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({ total: records.length, success: okCount, records }, null, 2) + '\n');
  console.log('\n完成：' + okCount + '/' + records.length + ' 成功；产物在 ' + outDir);
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(String((e && e.stack) || e));
    process.exit(1);
  });
}
