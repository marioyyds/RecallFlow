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
import { parseArgs, validateAllowRisk, loadTasksFromJson, selectTasks } from './config.mjs';
import { normalizeTask, buildInstruction, toAgentResponse, validateAgentResponse } from '../../lib/eval/webarena-adapter.mjs';
import { McpBridgeClient } from './mcp-client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MCP_DIR = path.join(ROOT, 'integrations', 'opencode', 'recallflow-mcp');

const HELP = `RecallFlow × WebArena-Verified 评测编排器

用法：node integrations/webarena/run.mjs --tasks <file> [选项]

  --tasks <file>        WebArena 任务 JSON（[...] 或 { "tasks": [...] }）  [实跑必需]
  --out <dir>           产物目录（默认 ./webarena-out）
  --task-id <a,b>       只跑指定 task_id（可重复，逗号分隔）
  --limit <n>           只跑前 n 条（在 --task-id 过滤之后）
  --allow-risk <csv>    开工前声明的风险预算（默认 read,page,write,browser,network；不含 high）
  --poll-ms <n>         轮询间隔（默认 3000）
  --timeout-ms <n>      单任务墙钟上限（默认 300000）
  --profile-dir <dir>   浏览器用户数据目录（默认每条任务用临时目录 = 隔离）
  --ext <path>          扩展根目录（默认仓库根）
  --dry-run             不启浏览器，只校验任务并打印将发出的指令/终态契约
  -h, --help            显示本帮助
`;

function readTaskFile(file) {
  if (!file) throw new Error('缺少 --tasks <file>');
  const abs = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
  if (!fs.existsSync(abs)) throw new Error('任务文件不存在：' + abs);
  return loadTasksFromJson(fs.readFileSync(abs, 'utf8'));
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

/** 确保 7801 上的桥接服务在跑；不在就拉起一个（先连上的是它，扩展随后自动连）。 */
async function ensureBridgeServer(client) {
  const h = await client.health();
  if (h && (h.pid || h.ws !== undefined || h.ok !== undefined)) return null;
  const child = spawn(process.execPath, [path.join(MCP_DIR, 'index.js'), '--http'], {
    cwd: MCP_DIR,
    stdio: 'inherit',
    env: process.env,
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const probe = await client.health();
    if (probe && (probe.pid || probe.ws !== undefined || probe.ok !== undefined)) return child;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('桥接服务 15s 内没起来（' + path.join(MCP_DIR, 'index.js') + ' --http）');
}

async function runOne({ raw, opts, client, settings, outDir }) {
  const { launchBrowser, configureExtension, closeBrowser } = await import('./harness.mjs');
  const task = normalizeTask(raw);
  const instruction = buildInstruction(task);
  const harPath = path.join(outDir, 'har_' + task.taskId + '.har');
  const startedAt = Date.now();
  let context = null;
  let response;
  let job = null;
  try {
    context = await launchBrowser({ userDataDir: opts.profileDir || '', harPath, extPath: opts.extPath || undefined });
    await configureExtension(context, settings);
    await client.waitForExtension(60000);
    const opened = await client.openTab(task.startUrls[0]);
    if (!opened || opened.ok === false) throw new Error('open_tab 失败：' + JSON.stringify(opened));
    const started = await client.startAgentTask({ instruction, allowRisk: opts.allowRisk, tabId: opened.tabId });
    if (!started || started.ok === false) throw new Error('agent_task 启动失败：' + JSON.stringify(started));
    job = await client.waitForJob(started.jobId, {
      pollMs: opts.pollMs,
      timeoutMs: opts.timeoutMs,
      onProgress: (p) => process.stdout.write('    · seq=' + p.seq + ' state=' + p.state + ' omitted=' + (p.omitted || 0) + '\n'),
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
    duration_ms: Date.now() - startedAt,
    har: path.basename(harPath),
  };
  fs.writeFileSync(path.join(outDir, 'agent_response_' + task.taskId + '.json'), JSON.stringify(response, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'recallflow_' + task.taskId + '.json'), JSON.stringify(record, null, 2) + '\n');
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
  const tasks = selectTasks(rawTasks, { taskIds: opts.taskIds, limit: opts.limit });
  if (!tasks.length) {
    console.error('没有选中任何任务（检查 --task-id / 任务文件）。');
    process.exit(2);
  }
  if (opts.dryRun) {
    process.exit(dryRun(tasks, { allowRisk }));
  }

  const outDir = path.resolve(process.cwd(), opts.out || 'webarena-out');
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

  let server = null;
  const records = [];
  try {
    server = await ensureBridgeServer(client);
    await client.connect();
    console.log('桥接就绪，开始跑 ' + tasks.length + ' 条任务 → ' + outDir);
    for (const raw of tasks) {
      process.stdout.write('\n▶ task ' + (raw && (raw.task_id !== undefined ? raw.task_id : raw.taskId)) + '\n');
      records.push(await runOne({ raw, opts: Object.assign({}, opts, { allowRisk }), client, settings, outDir }));
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
