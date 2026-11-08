#!/usr/bin/env node
// WebArena-Verified 评测编排器：把 WebArena 的任务交给 RecallFlow 的真 agent 跑，并落盘可离线评测的产物。
//
// 产物（每条任务一个目录）：
//   agent_response_<id>.json  —— FinalAgentResponse（规范键 task_type/status/retrieved_data/error_details）
//   har_<id>.har              —— 网络 trace（WebArena-Verified 的 network 评测器读它）
//   agent_trace.jsonl         —— 完整 Agent 事件流（工具参数/结果、JEV、推理、验证、终态）
//   agent_trace.steps.jsonl   —— 聚合后的可分析步骤（逐 token 文本已合并）
//   agent_trace.md            —— 人类可读时间线
//   agent_trace.meta.json     —— 模型/JEV 配置摘要、轮询诊断与轨迹完整性
//   recallflow.json           —— 原始 job 终态与轨迹摘要，用于归因
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
import { parseArgs, validateAllowRisk, loadTasksFromJson, selectTasks, applySiteUrls, detectUnresolvedSites, parseLogin, deadlineForTask, selectRunnableTaskIndex, taskSiteScope } from './config.mjs';
import { normalizeTask, buildInstruction, toAgentResponse, validateAgentResponse } from '../../lib/eval/webarena-adapter.mjs';
import { McpBridgeClient } from './mcp-client.mjs';
import { AgentTraceRecorder } from './trace.mjs';
import { resetTaskSites } from './site-reset.mjs';
import { BrowserActionObserver, buildCorrectionInstruction } from './action-observer.mjs';
import {
  buildOriginalInstruction,
  evaluateOriginalTask,
  normalizeOriginalTask,
} from './original-evaluator.mjs';

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
  --poll-ms <n>         轮询间隔（默认 500；事件会立即追加到 agent_trace.jsonl）
  --timeout-ms <n>      单任务墙钟上限（默认 300000）
  --concurrency <n>     并行任务数（默认 3，最大 8；同一站点/账号仍严格串行）
  --site-reset <mode>   站点数据重置：per-task（默认）/ run / none
  --reset-wait-ms <n>   容器重置后的就绪等待上限（默认 180000）
  --action-retries <n>  无可观察动作时最多补执行次数（默认 1，最大 2）
  --task-format <mode>  任务格式：verified（默认）或 original（原始 WebArena）
  --image-set <mode>    站点镜像：verified（默认）或 original（原始 WebArena）
  --no-har              不录制 HAR（原版实时 evaluator 不需要，可显著减少磁盘）
  --profile-dir <dir>   浏览器用户数据目录（默认每条任务用临时目录 = 隔离）
  --ext <path>          扩展根目录（默认仓库根）
  --dry-run             不启浏览器，只校验任务并打印将发出的指令/终态契约
  -h, --help            显示本帮助

需要登录的站点（shopping / reddit）用环境变量提供凭据：
  RECALLFLOW_EVAL_SHOPPING_LOGIN=email:password
  RECALLFLOW_EVAL_SHOPPING_ADMIN_LOGIN=username:password
  RECALLFLOW_EVAL_REDDIT_LOGIN=username:password
  RECALLFLOW_EVAL_GITLAB_LOGIN=username:password
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
function dryRun(tasks, { allowRisk, taskFormat = 'verified' }) {
  let bad = 0;
  for (const raw of tasks) {
    try {
      const task = taskFormat === 'original' ? raw : normalizeTask(raw);
      const instruction = taskFormat === 'original' ? buildOriginalInstruction(task) : buildInstruction(task);
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
export function describeBridgeReuse(h, port = 7801) {
  if (!looksLikeBridge(h)) return '';
  const pid = h.pid ? 'pid=' + h.pid : 'pid 未知';
  const ws = h.ws ? '扩展已连上' : '扩展未连上';
  return (
    '警告：' + port + ' 上已有桥接服务在跑（' + pid + '，' + ws + '），本次将复用它 —— ' +
    '它可能加载的是旧代码（实测遇到过两天前启动的实例）。评测前建议重启该服务，' +
    '否则本轮修复可能不生效且不会报错。'
  );
}

/** 确保指定端口上的桥接服务在跑；评测 Worker 必须使用全新的独立实例。 */
async function ensureBridgeServer(client, { port = 7801, token = '', fresh = false } = {}) {
  const h = await client.health();
  const reuse = describeBridgeReuse(h, port);
  if (reuse) {
    if (fresh) throw new Error('端口 ' + port + ' 已有桥接服务；并发评测拒绝复用旧实例');
    console.warn(reuse);
    return null;
  }
  const child = spawn(process.execPath, [path.join(MCP_DIR, 'index.js'), '--http'], {
    cwd: MCP_DIR,
    stdio: 'inherit',
    env: Object.assign({}, process.env, {
      RECALLFLOW_MCP_PORT: String(port),
      ...(token ? { RECALLFLOW_BRIDGE_TOKEN: String(token) } : {}),
    }),
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const probe = await client.health();
    if (looksLikeBridge(probe)) return child;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('桥接服务 15s 内没起来（' + path.join(MCP_DIR, 'index.js') + ' --http）');
}

async function runOne({ raw, opts, client, settings, outDir, workerLabel = '' }) {
  const { launchBrowser, configureExtension, closeBrowser, prepareSiteLogin, navigateTabWithHeaders: syncTab } = await import('./harness.mjs');
  const originalMode = opts.taskFormat === 'original';
  const task = originalMode ? raw : normalizeTask(raw);
  const instruction = originalMode ? buildOriginalInstruction(task) : buildInstruction(task);
  const prefix = workerLabel ? '[' + workerLabel + '] ' : '';
  // 目录布局对齐 WebArena-Verified 的 evaluator：它按 `<out>/<task_id>/agent_response.json`
  // 和 `<out>/<task_id>/network.har` 找产物（文件名来自 types/config.py 的默认值）。
  // 用别的布局会得到"0 条可评测任务"，而且那个报错不会告诉你是文件名不对。
  const taskDir = path.join(outDir, String(task.taskId));
  fs.mkdirSync(taskDir, { recursive: true });
  const harPath = opts.captureHar === false ? '' : path.join(taskDir, 'network.har');
  const startedAt = Date.now();
  const trace = new AgentTraceRecorder({
    taskDir,
    taskId: task.taskId,
    instruction,
    settings: Object.assign({}, settings, { __pollMs: opts.pollMs }),
    startedAt,
  });
  let context = null;
  let response;
  let job = null;
  let failure = null;
  let traceCapture = null;
  let actionObserver = null;
  let nativeEvaluation = null;
  const actionChecks = [];
  try {
    if (opts.siteReset === 'per-task') {
      process.stdout.write(prefix + '    · 重置站点容器：' + task.sites.join(',') + '\n');
      trace.environmentReset = await resetTaskSites(task.sites, {
        mode: 'per-task',
        imageSet: opts.imageSet,
        timeoutMs: opts.resetWaitMs,
      });
      process.stdout.write(prefix + '    · 站点已恢复初始快照（' + trace.environmentReset.duration_ms + 'ms）\n');
    }
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
    actionObserver = new BrowserActionObserver(context, {
      sites: task.sites,
      siteUrls: opts.siteUrls || {},
      startUrl: task.startUrls[0],
    });
    actionObserver.markStart();
    const runAttempt = async (attemptInstruction, attempt) => {
      const started = await client.startAgentTask({ instruction: attemptInstruction, allowRisk: opts.allowRisk, tabId: opened.tabId });
      if (!started || started.ok === false) throw new Error('agent_task 启动失败：' + JSON.stringify(started));
      return client.waitForJob(started.jobId, {
        pollMs: opts.pollMs,
        timeoutMs: opts.timeoutMs,
        onProgress: (p) => {
          trace.recordProgress(p, { attempt });
          process.stdout.write(prefix + '    · attempt=' + attempt + ' seq=' + p.seq + ' state=' + p.state + ' omitted=' + (p.omitted || 0) + '\n');
          if ((p.omitted || 0) > 0) {
            process.stdout.write(prefix + '      ! 轨迹源已丢弃 ' + p.omitted + ' 条旧事件；meta 会标记为不完整\n');
          }
          if (process.env.RECALLFLOW_EVAL_DEBUG) {
            process.stdout.write(prefix + '      raw=' + JSON.stringify(p.raw).slice(0, 600) + '\n');
          }
        },
      });
    };
    job = await runAttempt(instruction, 1);
    response = originalMode
      ? {
          task_type: task.expectedAction || null,
          status: job.state === 'completed' ? 'SUCCESS' : 'UNKNOWN_ERROR',
          retrieved_data: null,
          error_details: job.error || null,
        }
      : toAgentResponse(job.result, { state: job.state, error: job.error, expectedAction: task.expectedAction });
    let inspection = actionObserver.inspect(task.expectedAction, task.intent);
    actionChecks.push(Object.assign({ attempt: 1 }, inspection));
    if (!inspection.ok) {
      process.stdout.write(prefix + '    ! 动作后置条件未满足：' + inspection.issues.join('；') + '\n');
    }
    for (let attempt = 2; attempt <= 1 + (Number(opts.actionRetries) || 0) && !inspection.ok; attempt += 1) {
      const remainingMs = Math.max(0, (Number(opts.timeoutMs) || 300000) - (Date.now() - startedAt));
      if (remainingMs < 30000) break;
      actionObserver.resetWindow();
      const correction = buildCorrectionInstruction(instruction, inspection);
      process.stdout.write(prefix + '    · 补执行 attempt=' + attempt + '\n');
      try {
        const retryJob = await client.waitForJob(
          (await client.startAgentTask({ instruction: correction, allowRisk: opts.allowRisk, tabId: opened.tabId })).jobId,
          {
            pollMs: opts.pollMs,
            timeoutMs: remainingMs,
            onProgress: (p) => {
              trace.recordProgress(p, { attempt });
              process.stdout.write(prefix + '    · attempt=' + attempt + ' seq=' + p.seq + ' state=' + p.state + ' omitted=' + (p.omitted || 0) + '\n');
            },
          }
        );
        if (retryJob) {
          job = retryJob;
          response = originalMode
            ? {
                task_type: task.expectedAction || null,
                status: job.state === 'completed' ? 'SUCCESS' : 'UNKNOWN_ERROR',
                retrieved_data: null,
                error_details: job.error || null,
              }
            : toAgentResponse(job.result, { state: job.state, error: job.error, expectedAction: task.expectedAction });
        }
        inspection = actionObserver.inspect(task.expectedAction, task.intent);
        actionChecks.push(Object.assign({ attempt }, inspection));
        if (!inspection.ok) process.stdout.write(prefix + '    ! 补执行后仍未满足：' + inspection.issues.join('；') + '\n');
      } catch (retryError) {
        actionChecks.push({ attempt, ok: false, error: String((retryError && retryError.message) || retryError) });
        process.stderr.write(prefix + '    ! 补执行失败（保留上一轮结果）：' + String((retryError && retryError.message) || retryError) + '\n');
        break;
      }
    }
    if (originalMode && context) {
      const answer = typeof job?.result === 'string' ? job.result : JSON.stringify(job?.result ?? '');
      try {
        nativeEvaluation = await evaluateOriginalTask({
          task,
          answer,
          context,
          settings,
          siteUrls: opts.siteUrls || {},
        });
        process.stdout.write(prefix + '    · 原始 WebArena 评分=' + nativeEvaluation.score + '\n');
      } catch (evaluationError) {
        nativeEvaluation = {
          evaluator: 'webarena-original-compatible',
          score: 0,
          success: false,
          error: String((evaluationError && evaluationError.message) || evaluationError),
        };
        process.stderr.write(prefix + '    ! 原始 WebArena 评分失败：' + nativeEvaluation.error + '\n');
      }
    }
  } catch (e) {
    failure = String((e && e.message) || e);
    response = originalMode
      ? {
          task_type: task && task.expectedAction || null,
          status: 'UNKNOWN_ERROR',
          retrieved_data: null,
          error_details: failure,
        }
      : toAgentResponse('', { state: 'failed', error: failure, expectedAction: task && task.expectedAction });
    job = Object.assign({ state: 'failed' }, job || {}, { error: failure });
  } finally {
    if (actionObserver) actionObserver.dispose();
    trace.actionChecks = actionChecks;
    if (context) {
      try {
        await closeBrowser(context);
      } catch (closeError) {
        process.stderr.write(prefix + '    ! 浏览器关闭失败（轨迹仍会收尾）：' + String((closeError && closeError.message) || closeError) + '\n');
      }
    }
    try {
      traceCapture = trace.finish({ job, response, error: failure, har: harPath });
    } catch (traceError) {
      const message = String((traceError && traceError.message) || traceError);
      process.stderr.write(prefix + '    ! 轨迹元数据收尾失败：' + message + '\n');
      traceCapture = { complete: false, recorded_events: 0, omitted: null, gaps: [] };
      if (!failure) {
        failure = '轨迹元数据写入失败：' + message;
        response = toAgentResponse('', { state: 'failed', error: failure, expectedAction: task.expectedAction });
        job = Object.assign({}, job || {}, { state: 'failed', error: failure });
      }
    }
  }
  const check = originalMode ? { ok: true, errors: [] } : validateAgentResponse(response);
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
    har: harPath ? path.basename(harPath) : null,
    trace: {
      events_file: 'agent_trace.jsonl',
      meta_file: 'agent_trace.meta.json',
      complete: Boolean(traceCapture && traceCapture.complete),
      recorded_events: traceCapture ? traceCapture.recorded_events : 0,
      omitted: traceCapture ? traceCapture.omitted : 0,
      gaps: traceCapture ? traceCapture.gaps : [],
    },
    environment_reset: trace.environmentReset,
    action_checks: actionChecks,
    ...(originalMode ? { native_evaluation: nativeEvaluation } : {}),
  };
  if (originalMode) {
    fs.writeFileSync(path.join(taskDir, 'agent_answer.txt'), String(record.answer || '') + '\n');
    fs.writeFileSync(
      path.join(taskDir, 'original_eval_result.json'),
      JSON.stringify(nativeEvaluation || { score: 0, success: false, error: 'missing evaluation' }, null, 2) + '\n'
    );
  } else {
    fs.writeFileSync(path.join(taskDir, 'agent_response.json'), JSON.stringify(response, null, 2) + '\n');
  }
  fs.writeFileSync(path.join(taskDir, 'recallflow.json'), JSON.stringify(record, null, 2) + '\n');
  const passed = originalMode ? nativeEvaluation?.score === 1 : response.status === 'SUCCESS';
  const flag = passed ? 'OK ' : 'FAIL';
  const detail = originalMode
    ? (nativeEvaluation?.success ? 'WEBARENA_PASS' : 'WEBARENA_FAIL')
    : response.status;
  console.log(prefix + '  [' + flag + '] task ' + task.taskId + ' → ' + detail + (check.ok ? '' : '（schema: ' + check.errors.join('；') + '）'));
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
  let actionById = new Map();
  if (opts.taskFormat === 'original') {
    const verifiedTaskPath = path.join(ROOT, 'webarena-verified.json');
    if (fs.existsSync(verifiedTaskPath)) {
      const verifiedTasks = loadTasksFromJson(fs.readFileSync(verifiedTaskPath, 'utf8'));
      actionById = new Map(verifiedTasks.map((task) => [
        Number(task.task_id !== undefined ? task.task_id : task.taskId),
        normalizeTask(task).expectedAction,
      ]));
    }
  }
  const mapped = rawTasks.map((t) =>
    opts.taskFormat === 'original'
      ? normalizeOriginalTask(t, opts.siteUrls, actionById)
      : applySiteUrls(t, opts.siteUrls)
  );
  const outDir = path.resolve(process.cwd(), opts.out || 'webarena-out');
  let tasks = selectTasks(mapped, { taskIds: opts.taskIds, sites: opts.sites, limit: 0 });
  if (opts.resume && !opts.dryRun) {
    const before = tasks.length;
    const doneFile = opts.taskFormat === 'original' ? 'original_eval_result.json' : 'agent_response.json';
    tasks = tasks.filter((t) => !fs.existsSync(path.join(outDir, String(taskIdOf(t)), doneFile)));
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
    process.exit(dryRun(tasks, { allowRisk, taskFormat: opts.taskFormat }));
  }

  fs.mkdirSync(outDir, { recursive: true });

  const apiKey = process.env.RECALLFLOW_EVAL_API_KEY || process.env.RECALLFLOW_WEBARENA_API_KEY || '';
  const bridgeToken = process.env.RECALLFLOW_BRIDGE_TOKEN || 'recallflow-local-bridge-v1';
  const bridgeHost = process.env.RECALLFLOW_MCP_HOST || '127.0.0.1';
  const bridgePortBase = Number(process.env.RECALLFLOW_MCP_PORT) || 7801;
  const settings = (await import('./harness.mjs')).webarenaSettings({
    apiKey,
    baseUrl: process.env.RECALLFLOW_EVAL_BASE_URL || process.env.RECALLFLOW_WEBARENA_BASE_URL,
    model: process.env.RECALLFLOW_EVAL_MODEL || process.env.RECALLFLOW_WEBARENA_MODEL,
    bridgeToken,
    jev: process.env.RECALLFLOW_EVAL_JEV_SETTINGS || null,
  });
  if (opts.taskFormat === 'original') settings.requireFinalJsonBlock = false;

  // 需要登录的站点凭据（公开数据集不再带 storage_state；按站点登录一次）。
  // 格式：email:password / username:password；不配就按游客跑（账户类任务会 PERMISSION_DENIED）。
  const logins = {};
  const shopLogin = parseLogin(process.env.RECALLFLOW_EVAL_SHOPPING_LOGIN);
  if (shopLogin) logins.shopping = { baseUrl: opts.siteUrls.SHOPPING || 'http://localhost:7770', email: shopLogin.user, password: shopLogin.password };
  const shopAdminLogin = parseLogin(process.env.RECALLFLOW_EVAL_SHOPPING_ADMIN_LOGIN);
  if (shopAdminLogin) logins.shopping_admin = { baseUrl: opts.siteUrls.SHOPPING_ADMIN || 'http://localhost:7780/admin', username: shopAdminLogin.user, password: shopAdminLogin.password };
  const redditLogin = parseLogin(process.env.RECALLFLOW_EVAL_REDDIT_LOGIN);
  if (redditLogin) logins.reddit = { baseUrl: opts.siteUrls.REDDIT || 'http://localhost:9999', username: redditLogin.user, password: redditLogin.password };
  const gitlabLogin = parseLogin(process.env.RECALLFLOW_EVAL_GITLAB_LOGIN);
  if (gitlabLogin) logins.gitlab = { baseUrl: opts.siteUrls.GITLAB || 'http://localhost:8023', username: gitlabLogin.user, password: gitlabLogin.password };
  const shoppingState = process.env.RECALLFLOW_EVAL_SHOPPING_STATE || '';
  const redditState = process.env.RECALLFLOW_EVAL_REDDIT_STATE || '';

  const records = [];
  const workerCount = Math.min(Math.max(1, Number(opts.concurrency) || 3), tasks.length);
  const workers = Array.from({ length: workerCount }, (_, index) => {
    const port = bridgePortBase + index;
    const token = bridgeToken + ':worker-' + (index + 1);
    return {
      index,
      label: 'w' + (index + 1),
      port,
      token,
      busy: false,
      client: new McpBridgeClient({ host: bridgeHost, port, token }),
      settings: Object.assign({}, settings, { bridgeToken: token, bridgePort: port }),
      server: null,
    };
  });
  try {
    await Promise.all(workers.map(async (worker) => {
      worker.server = await ensureBridgeServer(worker.client, {
        port: worker.port,
        token: worker.token,
        fresh: true,
      });
      await worker.client.connect();
    }));
    console.log('桥接就绪，使用 ' + workerCount + ' 个 Worker 开始跑 ' + tasks.length + ' 条任务 → ' + outDir);
    if (opts.siteReset === 'run') {
      const sites = [...new Set(tasks.flatMap((task) => taskSiteScope(task))
        .filter((site) => site !== '__unscoped__'))];
      console.log('任务批次开始前重置站点容器：' + sites.join(','));
      const reset = await resetTaskSites(sites, { mode: 'run', timeoutMs: opts.resetWaitMs });
      fs.writeFileSync(path.join(outDir, 'environment-reset.json'), JSON.stringify(reset, null, 2) + '\n');
      console.log('站点初始快照已恢复（' + reset.duration_ms + 'ms）');
    }
    const pending = tasks.slice();
    const activeSites = new Set();
    let activeTasks = 0;
    let completedTasks = 0;
    const fatalErrors = [];
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };
      const pump = () => {
        let launched;
        do {
          launched = false;
          for (const worker of workers) {
            if (worker.busy) continue;
            const index = selectRunnableTaskIndex(pending, activeSites);
            if (index < 0) break;
            const [raw] = pending.splice(index, 1);
            const scope = taskSiteScope(raw);
            const taskId = raw && (raw.task_id !== undefined ? raw.task_id : raw.taskId);
            worker.busy = true;
            activeTasks += 1;
            for (const site of scope) activeSites.add(site);
            process.stdout.write('\n[' + worker.label + '] ▶ task ' + taskId + '（账号锁：' + scope.join('+') + '）\n');
            runOne({
              raw,
              opts: Object.assign({}, opts, { allowRisk, logins, shoppingState, redditState }),
              client: worker.client,
              settings: worker.settings,
              outDir,
              workerLabel: worker.label,
            })
              .then((record) => records.push(record))
              .catch((error) => {
                const message = '[' + worker.label + '] task ' + taskId + ' 未完成调度：' + String((error && error.message) || error);
                fatalErrors.push(message);
                process.stderr.write(message + '\n');
              })
              .finally(() => {
                worker.busy = false;
                activeTasks -= 1;
                completedTasks += 1;
                for (const site of scope) activeSites.delete(site);
                pump();
              });
            launched = true;
          }
        } while (launched);

        if (completedTasks === tasks.length) {
          finish(fatalErrors.length ? new Error(fatalErrors.join('\n')) : null);
        } else if (activeTasks === 0 && pending.length) {
          finish(new Error('调度器无法启动剩余任务：' + pending.length + ' 条任务与当前站点锁冲突'));
        }
      };
      pump();
    });
  } finally {
    for (const worker of workers) {
      if (worker.server) worker.server.kill();
    }
  }
  records.sort((a, b) => Number(a.task_id) - Number(b.task_id));
  const okCount = records.filter((r) =>
    opts.taskFormat === 'original'
      ? r.native_evaluation?.score === 1
      : r.response.status === 'SUCCESS'
  ).length;
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({
    total: records.length,
    success: okCount,
    task_format: opts.taskFormat,
    native_evaluator: opts.taskFormat === 'original' ? 'webarena-original-compatible' : null,
    concurrency: workerCount,
    account_isolation: 'site-exclusive',
    records,
  }, null, 2) + '\n');
  console.log('\n完成：' + okCount + '/' + records.length + ' 成功；产物在 ' + outDir);
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(String((e && e.stack) || e));
    process.exit(1);
  });
}
