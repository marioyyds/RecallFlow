#!/usr/bin/env node
// agent_task / open_tab 的端到端自检（对着**真实**的 7801 + 已加载扩展跑）。
//
// 为什么要有它：这条链路的失败模式几乎都是"静默"的 ——
//   · 扩展侧代码没重载 → 服务端明明暴露了新工具，调用却报 `unknown method`；
//   · 守卫装错了地方 → 不报错，只是**静默放行**声明外的工具；
//   · 忘了声明 allowRisk → 拒绝信息若不可操作，调用方只会反复重试同一个错。
// 这些都不该靠"来回猜 + 手工点"，而该有一条命令给出逐项结论。
//
// 用法：
//   node scripts/verify-agent-task.mjs            # 只读检查（不跑真任务、不花钱）
//   node scripts/verify-agent-task.mjs --run      # 额外真跑一次任务（需要 API Key，会产生模型费用）
//
// 退出码：0 全通过 / 1 有失败项。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const HOST = '127.0.0.1';
const PORT = Number(process.env.RECALLFLOW_MCP_PORT) || 7801;
const TOKEN = String(process.env.RECALLFLOW_BRIDGE_TOKEN || '').trim() || 'recallflow-local-bridge-v1';
const WANT_RUN = process.argv.includes('--run');

let failed = 0;
let passed = 0;

function ok(label, extra = '') {
  passed += 1;
  console.log('  ✔ ' + label + (extra ? '  — ' + extra : ''));
}
function bad(label, detail = '') {
  failed += 1;
  console.log('  ✖ ' + label + (detail ? '\n      ' + String(detail).split('\n').join('\n      ') : ''));
}
function info(msg) {
  console.log('  · ' + msg);
}

function request(method, path, { headers = {}, body = null, timeoutMs = 90000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port: PORT, method, path, headers, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('timeout', () => { req.destroy(new Error('请求超时（' + timeoutMs + 'ms）')); });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

const mcpHeaders = (extra = {}) =>
  Object.assign(
    { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'X-RecallFlow-Token': TOKEN },
    extra
  );

async function openSession() {
  const res = await request('POST', '/mcp', {
    headers: mcpHeaders(),
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify-agent-task', version: '1' } },
    },
  });
  const sid = res.headers['mcp-session-id'];
  if (!sid) throw new Error('initialize 未返回 mcp-session-id（服务端在跑吗？）');
  const headers = mcpHeaders({ 'mcp-session-id': sid });
  await request('POST', '/mcp', { headers, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  return headers;
}

async function callTool(headers, name, args, id = 2) {
  const res = await request('POST', '/mcp', {
    headers,
    body: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args || {} } },
  });
  const parsed = JSON.parse(res.body);
  const content = parsed.result && parsed.result.content && parsed.result.content[0];
  const text = content ? content.text : '';
  try {
    return JSON.parse(text);
  } catch (e) {
    return { _raw: text, _isError: Boolean(parsed.result && parsed.result.isError) };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 哪个浏览器加载了本仓库的扩展？
 *
 * 为什么需要它：重载扩展是**浏览器 UI 动作**，没法自动化；
 * 而一台机器上可能同时装了 Chrome 与 Edge。若把"重新加载"点在**没加载本仓库**的那个浏览器上，
 * 现象完全一样（我这边仍然探测到旧代码），于是会一直以为是重载没生效 ——
 * 实测这台机器就是这种情况：Chrome 没加载本仓库，Edge 加载了。
 *
 * 只读 Preferences（不碰 LevelDB），失败就静默跳过：这只是把提示指得更准，不是硬依赖。
 */
function detectBrowser() {
  const local = process.env.LOCALAPPDATA || '';
  const candidates = [
    ['Edge', path.join(local, 'Microsoft', 'Edge', 'User Data', 'Default', 'Preferences')],
    ['Chrome', path.join(local, 'Google', 'Chrome', 'User Data', 'Default', 'Preferences')],
  ];
  const hits = [];
  for (const [name, file] of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const txt = fs.readFileSync(file, 'utf8');
      // 解压扩展在 Preferences 里只记 path，不记 manifest/name（见 docs/local-service.md），
      // 所以只能按"工作区路径片段"判断，且必须限定在用户数据目录之内，避免把
      // 浏览器历史/下载记录里的同名路径也算进来。
      if (txt.includes('bookmark-sorter')) hits.push(name);
    } catch (e) {
      /* 读不到就跳过 */
    }
  }
  return hits;
}

const browsers = detectBrowser();
const reloadHint = browsers.length
  ? '请在 ' + browsers.join(' / ') + ' 打开 ' + browsers.map((b) => (b === 'Edge' ? 'edge://extensions' : 'chrome://extensions')).join(' 或 ') + '，点一次 RecallFlow 的「重新加载」'
  : '请在加载了 RecallFlow 的那个浏览器打开 chrome://extensions（或 edge://extensions），点一次「重新加载」';

console.log('RecallFlow agent_task 自检 → http://' + HOST + ':' + PORT);
if (browsers.length) console.log('（检测到本仓库扩展装在：' + browsers.join('、') + '）');
console.log('');

// ---------- 1. 服务活着吗 + 扩展连上了吗 ----------
console.log('[1] 本地服务与扩展连接');
let health = null;
try {
  const r = await request('GET', '/health', { timeoutMs: 5000 });
  health = JSON.parse(r.body);
  ok('服务在跑', 'pid=' + health.pid);
} catch (e) {
  bad('服务没在跑', String(e.message) + '\n先启动：node integrations/opencode/recallflow-mcp/index.js --http');
  console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败');
  process.exit(1);
}
if (health.ws) ok('扩展已连接（ws=true）');
else bad('扩展未连接（ws=false）', '打开/刷新浏览器，确认 RecallFlow 扩展已启用；它会自动重连');

// ---------- 2. 工具面 ----------
console.log('\n[2] MCP 工具面');
let headers;
try {
  headers = await openSession();
} catch (e) {
  bad('无法建立 MCP 会话', String(e.message));
  console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败');
  process.exit(1);
}
const listRes = await request('POST', '/mcp', { headers, body: { jsonrpc: '2.0', id: 9, method: 'tools/list' } });
const tools = JSON.parse(listRes.body).result.tools.map((t) => t.name);
for (const n of ['open_tab', 'agent_task', 'agent_task_status', 'agent_task_cancel']) {
  if (tools.includes(n)) ok('暴露 ' + n);
  else bad('缺少工具 ' + n, '服务端代码是旧的？重启 7801 上的进程');
}
const pa = JSON.parse(listRes.body).result.tools.find((t) => t.name === 'page_action');
if (pa && Object.keys(pa.inputSchema.properties || {}).includes('tabId')) ok('page_action 支持 tabId');
else bad('page_action 缺 tabId', '服务端代码是旧的？重启 7801 上的进程');

// ---------- 3. 扩展侧代码是否已重载（这是最容易误判的一步） ----------
console.log('\n[3] 扩展侧代码版本');
info('服务端暴露了新工具 ≠ 扩展认识它；这一步专门区分这两件事。');
const reloadProbe = await callTool(headers, 'agent_task', { instruction: '探针', allowRisk: ['high'] }, 10);
const rawProbe = String(reloadProbe._raw || '');
if (/unknown method/.test(rawProbe)) {
  bad(
    '扩展仍是旧代码',
    '调用 agent_task 返回：' + rawProbe + '\n' +
      reloadHint + '。\n' +
      '服务端已就绪，但扩展必须重载才能认识新方法 —— 这不会自动发生。\n' +
      '⚠ 点错浏览器不会有任何不同：我这边同样只看到旧代码。'
  );
  console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败（扩展重载后重跑本脚本）');
  process.exit(1);
}
ok('扩展已重载，认识 agent_task');

// ---------- 4. 授权判定：high 任何声明都换不到 ----------
console.log('\n[4] allowRisk 授权判定');
const highRes = await callTool(headers, 'agent_task', { instruction: '探针', allowRisk: ['high'] }, 11);
if (highRes.ok === false && highRes.code === 'BAD_ALLOW_RISK') ok('拒绝 allowRisk 含 high', highRes.error);
else bad('allowRisk 含 high 应被拒', JSON.stringify(highRes));

const badRisk = await callTool(headers, 'agent_task', { instruction: '探针', allowRisk: ['everything'] }, 12);
if (badRisk.ok === false && /everything/.test(String(badRisk.error))) ok('拒绝未知类别并点名是哪个', badRisk.error);
else bad('未知类别应被拒且点名', JSON.stringify(badRisk));

// ---------- 5. 只读观测修复：ref 的来源不能要求先有 ref ----------
console.log('\n[5] 只读观测工具（ref 的来源）');
const frames = await callTool(headers, 'page_action', { tool: 'list_frames' }, 13);
if (frames.ok === false && frames.code === 'NO_TARGET') {
  bad('list_frames 仍被 NO_TARGET 误拒', '扩展侧 bridge-write-policy 未重载（BRIDGE_INSPECT_TOOLS 未生效）');
} else if (frames.ok === false && frames.code === 'AGENT_TASK_RUNNING') {
  info('有任务在跑，跳过（与本次检查无关）');
} else {
  ok('list_frames 无参可调（只读观测已放行）');
}

// ---------- 6. 真跑一次任务（可选） ----------
console.log('\n[6] 真跑一次任务' + (WANT_RUN ? '' : '（未加 --run，跳过）'));
if (!WANT_RUN) {
  info('加 --run 会真跑一次任务（需要扩展已配 API Key，会产生模型费用）。');
  info('建议先自己打开一个无害页面，避免它在你的真实站点上动手。');
} else {
  // 刻意用本机探活页做目标：它无害、可重复、且不涉及任何真实站点登录态。
  const target = 'http://' + HOST + ':' + PORT + '/health';
  const opened = await callTool(headers, 'open_tab', { url: target }, 20);
  if (opened.ok) ok('open_tab 打开目标页', 'tabId=' + opened.tabId);
  else bad('open_tab 失败', JSON.stringify(opened));

  const started = await callTool(headers, 'agent_task', {
    instruction: '读一下当前页面的标题，然后用一句话告诉我这个页面上有什么。不要点击任何东西。',
    allowRisk: ['read', 'page'],
    tabId: opened.tabId,
  }, 21);
  if (!started.ok) {
    bad('启动任务失败', JSON.stringify(started));
    if (String(started.error || '').indexOf('API Key') >= 0) {
      info('这是预期内的前置条件失败：扩展设置页需要填 API Key。');
    }
  } else {
    ok('任务已启动', 'jobId=' + started.jobId);
    // 立刻查一次：必须快进快出（不能同步等任务跑完）
    const t0 = Date.now();
    const first = await callTool(headers, 'agent_task_status', { jobId: started.jobId, sinceSeq: 0 }, 22);
    const dt = Date.now() - t0;
    if (first.running !== undefined) ok('status 可读', '首次查询 ' + dt + 'ms，seq=' + first.seq);
    else bad('status 读不到该 job', JSON.stringify(first));

    let seq = Number(first.seq) || 0;
    let state = first.state;
    const deadline = Date.now() + 120000;
    while (state === 'running' && Date.now() < deadline) {
      await sleep(3000);
      const s = await callTool(headers, 'agent_task_status', { jobId: started.jobId, sinceSeq: seq }, 23);
      if (s.seq !== undefined) seq = Number(s.seq) || seq;
      if (s.state) state = s.state;
      if (s.events && s.events.length) {
        info('+' + s.events.length + ' 事件（seq=' + seq + '）state=' + state);
      }
    }
    const fin = await callTool(headers, 'agent_task_status', { jobId: started.jobId, sinceSeq: 0 }, 24);
    if (state === 'completed') {
      ok('任务完成', 'state=' + state);
      // 结果回传：目标要求"含结果回传"，所以成功必须能读到答复
      if (String(fin.result || '').trim()) ok('拿得到最终答复', JSON.stringify(String(fin.result).slice(0, 120)));
      else bad('任务成功但拿不到答复', '结果回传缺失（finalAnswerFrom 没生效？）');
      if (fin.omitted) info('注意：有 ' + fin.omitted + ' 条最旧事件因上限被丢弃（日志有缺口）');
    } else if (state === 'running') {
      bad('任务在 120s 内没结束', '可能卡在等审批（守卫/预放行没生效？）。用 agent_task_cancel 收尾。');
    } else {
      ok('任务已结束', 'state=' + state + (fin.error ? '，error=' + fin.error : ''));
    }
  }
}

console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败');
process.exit(failed ? 1 : 0);
