// 桥接分发的**行为**测试（lib/bridge/relay.js）。
//
// 为什么需要它：relay.js 只在扩展里运行（引用 chrome / WebSocket 等浏览器全局），
// 因此此前**没有任何测试 import 过它** —— 它的分支、参数校验、错误码
// 全都只在"重载扩展之后"才被真正执行过。而那条链路恰恰是最贵的人工回路：
// 一个写错的错误码或漏掉的校验，表现往往是"工具调用怪怪的"，
// 很容易被误判成服务端问题。
//
// 做法：用桩替换浏览器全局后直接 import 并调用 dispatch()。
// 这些测试**不碰真实浏览器**：桩让 chrome.* 返回空/失败，正好用来验证
// "拿不到东西时给出的是什么" —— 而错误路径才是最该钉住的。
import test from 'node:test';
import assert from 'node:assert/strict';

// ---- 浏览器全局桩（必须在 import relay.js 之前装好）----
const chromeStub = {
  tabs: {
    query: async () => [],
    get: async () => null,
    update: async () => {},
    create: async () => null,
  },
  // 必须给 apiKey：没有它的话启动路径会**立刻**把 job 标成 failed，
  // 于是"任务在跑"这一类断言全都不成立（这是测试环境问题，不是产品缺陷）。
  storage: { local: { get: async () => ({ aiSettings: { apiKey: 'test-key' } }), set: async () => {} } },
  runtime: { onMessage: { addListener() {} }, lastError: null },
};
globalThis.chrome = chromeStub;
globalThis.WebSocket = class { constructor() {} addEventListener() {} send() {} close() {} };

const { dispatch, __setAgentRunnerForTests } = await import('../lib/bridge/relay.js');
const { JOB_STATE } = await import('../lib/bridge/agent-job.js');

/**
 * 可控的假 agent 运行入口。
 *
 * 为什么需要注入：真实实现要调模型（需要 Key、花钱、耗时不稳），
 * 而"任务**稳定处于 running**"恰恰是并发拒绝 / 取消 / 任务期间禁止外部动页面
 * 这几条断言的前提。注入后这些路径全部变成确定性的。
 */
let runnerBehavior = 'hang';
/** 记录最近一次注入 runner 收到的 (payload, settings, signal)，供接线断言。 */
let lastRun = null;

__setAgentRunnerForTests(async (port, payload, settings, book, signal) => {
  lastRun = { port, payload, settings, book, signal };
  if (runnerBehavior === 'hang') {
    // 一直等到被取消 —— 模拟"任务还在跑"。
    await new Promise((resolve) => {
      if (signal && signal.aborted) return resolve();
      if (signal && signal.addEventListener) signal.addEventListener('abort', resolve);
    });
    return;
  }
  if (runnerBehavior === 'chunksThenEnd') {
    port.postMessage({ type: 'chunk', text: '已经' });
    port.postMessage({ type: 'chunk', text: '完成。' });
    port.postMessage({ type: 'end' });
    return;
  }
  if (runnerBehavior === 'throw') throw new Error('注入的失败');
});

/** 等到注入的 runner 真的被调用（dispatch 是立刻返回的，runner 在后台异步启动）。 */
async function waitForRun() {
  for (let i = 0; i < 100; i += 1) {
    if (lastRun) return lastRun;
    await new Promise((res) => setTimeout(res, 5));
  }
  return null;
}

/**
 * 确保没有任务占着串行槽（用例之间互不污染）。
 *
 * 必须**等到终态**再返回，不能只发一个 cancel 就走：
 * 注入的 runner 收到 abort 后是在**自己的微任务里**结束的，
 * cancel 一返回任务仍是 running —— 下一个用例于是会撞上 AGENT_TASK_BUSY，
 * 表现为"与被测行为无关的失败"（这类失败最浪费时间）。
 */
async function clearJobs() {
  for (let round = 0; round < 5; round += 1) {
    const st = await dispatch('agent_task_status', {});
    const id = st.runningJobId;
    if (!id) return;
    await dispatch('agent_task_cancel', { jobId: id });
    for (let i = 0; i < 50; i += 1) {
      const s = await dispatch('agent_task_status', { jobId: id });
      if (!s || s.running === false) break;
      await new Promise((res) => setTimeout(res, 5));
    }
  }
}

// ---------------- 未知方法 ----------------

test('dispatch：未知方法报错并带上方法名（便于两端对账）', async () => {
  await assert.rejects(() => dispatch('no_such_method', {}), /unknown method: no_such_method/);
});

// ---------------- open_tab：只有 http(s) ----------------

test('open_tab：非 http(s) 被拒，且说明越过了什么边界', async () => {
  for (const url of ['chrome://settings', 'file:///C:/x.txt', 'javascript:alert(1)']) {
    const r = await dispatch('open_tab', { url });
    assert.equal(r.ok, false, url + ' 不得放行');
    assert.equal(r.code, 'BAD_URL');
  }
});

test('open_tab：缺 url 时报 NO_URL（与"给了但不允许"分开）', async () => {
  const r = await dispatch('open_tab', {});
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NO_URL');
});

// ---------------- agent_task：授权与参数 ----------------

test('agent_task：缺 instruction 时明确报错，不启动任何任务', async () => {
  const r = await dispatch('agent_task', { allowRisk: ['page'] });
  assert.equal(r.ok, false);
  assert.match(r.error, /instruction/);
});

test('agent_task：allowRisk 含 high 一律拒绝（扩展侧是最后一道，必须自己拦）', async () => {
  const r = await dispatch('agent_task', { instruction: '测试', allowRisk: ['read', 'high'] });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'BAD_ALLOW_RISK');
  assert.match(r.error, /high/);
});

test('agent_task：未知类别被拒且点名是哪个值（不静默丢弃安全声明）', async () => {
  const r = await dispatch('agent_task', { instruction: '测试', allowRisk: ['page', 'everything'] });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'BAD_ALLOW_RISK');
  assert.match(r.error, /everything/);
});

test('agent_task：合法声明会真的启动任务，并给出 approvedTools（供调用方核对授权面）', async () => {
  await clearJobs();
  const r = await dispatch('agent_task', { instruction: '读一下页面标题', allowRisk: ['page'] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.jobId, '应返回 jobId');
  assert.equal(r.state, 'running');
  assert.ok(Array.isArray(r.approvedTools), 'approvedTools 应是数组');
  // 预放行的只能是 click/type 这类页面动作；高风险绝不出现
  assert.ok(!r.approvedTools.includes('run_javascript'), 'run_javascript 绝不能被预放行');
  assert.ok(!r.approvedTools.includes('upload_file'), 'upload_file 绝不能被预放行');
  // 只读工具不需要审批，不该出现在清单里
  assert.ok(!r.approvedTools.includes('get_page_snapshot'), '只读工具不该进预放行清单');
  // 声明了 page，就该把页面动作预放行（否则会卡在等审批上）
  assert.ok(r.approvedTools.length > 0, '声明 page 后应有页面动作被预放行');
  await clearJobs();
});

test('agent_task：把 allowRisk 归一化后的授权面交给运行入口（且经 settings 传守卫）', async () => {
  await clearJobs();
  runnerBehavior = 'hang';
  const started = await dispatch('agent_task', { instruction: 'x', allowRisk: ['page'] });
  await waitForRun();
  assert.ok(lastRun, '注入的运行入口应被调用');
  // 守卫必须真的挂在 settings 上 —— 挂错了地方不会报错，只会静默放行（这是本轮修过的真缺陷）
  assert.equal(typeof lastRun.settings.agentBudgetGuard, 'function', '守卫必须经 settings 传给运行入口');
  // 守卫本身要真的拦得住：未声明的类别被拒
  const verdict = lastRun.settings.agentBudgetGuard('upload_file');
  assert.equal(verdict.allowed, false, 'upload_file 未声明，守卫必须拒绝');
  const allowed = lastRun.settings.agentBudgetGuard('click_element');
  assert.equal(allowed.allowed, true, 'click_element 属 page，已声明，应放行');
  await clearJobs();
  lastRun = null;
});

test('agent_task：预放行清单必须以 agent 循环真正读的那个键名传进去', async () => {
  // 这是最容易静默失效的一处接线：agent 循环读的是 `payload.sessionApprovedTools`
  //（见 agent.js 的 `new Set(canResume ? persisted.sessionApprovedTools : payload.sessionApprovedTools)`）。
  // 键名写错或塞进 settings 都不会报错 —— 只表现为任务**卡在等一个没人回答的审批上**，
  // 最后被 stalled 收割，而错误信息里看不出"其实是预放行没送到"。
  await clearJobs();
  runnerBehavior = 'hang';
  const started = await dispatch('agent_task', { instruction: 'x', allowRisk: ['page'] });
  await waitForRun();
  assert.ok(lastRun, '注入的运行入口应被调用');
  const payload = lastRun.payload;
  assert.ok(Array.isArray(payload.sessionApprovedTools), 'sessionApprovedTools 必须是数组（键名不能变）');
  assert.deepEqual(
    payload.sessionApprovedTools.slice().sort(),
    started.approvedTools.slice().sort(),
    '启动返回的 approvedTools 与真正交给循环的清单必须一致（否则调用方看到的授权面是假的）'
  );
  assert.ok(payload.sessionApprovedTools.length > 0, '声明 page 后必须真有页面动作被预放行');
  assert.equal(payload.runId, started.jobId, 'runId 必须是 jobId（恢复与落盘都靠它对齐）');
  assert.equal(payload.question, 'x', '指令要以 question 传给循环');
  await clearJobs();
  lastRun = null;
});

test('agent_task：并发被拒，且给出在跑的那个 jobId（不排队）', async () => {
  await clearJobs();
  const first = await dispatch('agent_task', { instruction: '长任务', allowRisk: ['page'] });
  assert.equal(first.ok, true);
  const second = await dispatch('agent_task', { instruction: '又一个', allowRisk: ['page'] });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'AGENT_TASK_BUSY');
  assert.equal(second.runningJobId, first.jobId, '必须给出在跑的那个 jobId，否则调用方无从查起');
  await clearJobs();
});

// ---------------- agent_task_status ----------------

test('agent_task_status：不传 jobId 时返回"有没有在跑"+清单，而不是报错', async () => {
  const r = await dispatch('agent_task_status', {});
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.jobs), '应给出 job 清单');
  assert.equal(typeof r.runningJobId, 'string');
});

test('agent_task_status：jobId 不存在时明确报错（而不是给一个空壳让人以为任务正常）', async () => {
  const r = await dispatch('agent_task_status', { jobId: 'job-not-exist' });
  assert.equal(r.ok, false);
  assert.match(r.error, /job-not-exist/);
});

// ---------------- agent_task_cancel ----------------

test('agent_task_cancel：没有可取消的任务时明确报错', async () => {
  // 先确保没有在跑的
  const st = await dispatch('agent_task_status', {});
  if (st.runningJobId) await dispatch('agent_task_cancel', { jobId: st.runningJobId });
  const r = await dispatch('agent_task_cancel', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /没有可取消/);
});

test('agent_task_cancel：取消是异步的 —— 不假装已经停了', async () => {
  const r = await dispatch('agent_task', { instruction: '任务', allowRisk: ['page'] });
  assert.equal(r.ok, true);
  const c = await dispatch('agent_task_cancel', { jobId: r.jobId });
  assert.equal(c.ok, true);
  assert.match(c.note, /异步|确认/, '应说明取消是异步的、需要再查状态确认');
  // 刚取消完，状态不应谎报为 cancelled（真正终止由 agent 循环响应 signal 完成）
  const st = await dispatch('agent_task_status', { jobId: r.jobId });
  assert.ok(st.ok);
  assert.notEqual(st.state, 'stalled');
});

// ---------------- page_action：守卫与并发互斥 ----------------

test('page_action：agent 任务在跑时被拒（两个执行者不许同时动页面）', async () => {
  await clearJobs();
  runnerBehavior = 'hang';
  const started = await dispatch('agent_task', { instruction: '占住', allowRisk: ['page'] });
  assert.equal(started.ok, true);
  const r = await dispatch('page_action', { tool: 'list_frames' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'AGENT_TASK_RUNNING');
  assert.match(r.hint, /agent_task_status|agent_task_cancel/, '应指出下一步能做什么');
  await clearJobs();
});

test('open_tab：agent 任务在跑时同样被拒（不只是页面动作）', async () => {
  await clearJobs();
  runnerBehavior = 'hang';
  await dispatch('agent_task', { instruction: '占住', allowRisk: ['page'] });
  const r = await dispatch('open_tab', { url: 'https://example.com' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'AGENT_TASK_RUNNING', '否则会与正在跑的任务抢页面');
  await clearJobs();
});

test('任务结束后，页面动作重新可用（互斥不该永久生效）', async () => {
  await clearJobs();
  runnerBehavior = 'chunksThenEnd';
  const r = await dispatch('agent_task', { instruction: '短任务', allowRisk: ['page'] });
  assert.equal(r.ok, true);
  // 注入的 runner 是同步完成的，但 finish 发生在 await 之后 —— 轮询到终态为止
  let st = null;
  for (let i = 0; i < 20; i += 1) {
    st = await dispatch('agent_task_status', { jobId: r.jobId });
    if (st.state !== 'running') break;
    await new Promise((res) => setTimeout(res, 10));
  }
  assert.equal(st.state, 'completed', '任务应能正常结束');
  assert.match(st.result, /完成/, '结果回传：成功必须能读到答复');
  const after = await dispatch('page_action', { tool: 'list_frames' });
  assert.notEqual(after.code, 'AGENT_TASK_RUNNING', '任务结束后互斥必须解除');
});

test('page_action：不在白名单里的工具被拒（写入许可仍然生效）', async () => {
  const r = await dispatch('page_action', { tool: 'run_javascript', args: { code: 'alert(1)' } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TOOL_NOT_EXPOSED');
});

test('page_action：只读观测工具不需要定位参数（ref 的来源不能被自己挡住）', async () => {
  const r = await dispatch('page_action', { tool: 'list_frames' });
  // 桩里没有活动标签页，所以预期是"找不到标签页"，而**不是** NO_TARGET。
  assert.notEqual(r.code, 'NO_TARGET', 'list_frames 不该因缺少定位参数被拒');
});

// ---------------- 只读诊断：拿不到标签页时的错误必须可操作 ----------------

test('read_diagnostics：没有活动标签页时给出可操作的错误', async () => {
  await assert.rejects(
    () => dispatch('read_diagnostics', { kind: 'console' }),
    /活动标签页/,
    '应提示先切到目标页面，而不是笼统报错'
  );
});
