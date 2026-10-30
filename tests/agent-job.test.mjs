// agent job 存储：单任务串行、按游标增量读取、事件限长、缺口显式标注。
// 这些边界都是"静默出错"的高发区，因此逐条钉住。
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentJobStore, JOB_STATE, finalAnswerFrom } from '../lib/bridge/agent-job.ts';

function store(opts) {
  return new AgentJobStore(opts);
}

test('create：返回 running job，且带可用的 cursor 起点', () => {
  const s = store();
  const r = s.create({ instruction: '发一条内容', allowRisk: ['read', 'page'], tabId: 42 });
  assert.equal(r.ok, true);
  assert.equal(r.job.state, JOB_STATE.RUNNING);
  assert.equal(r.job.nextSeq, 1, 'seq 从 1 开始（0 表示"从头读"）');
  assert.equal(r.job.tabId, 42);
  assert.deepEqual(r.job.allowRisk, ['read', 'page']);
});

test('create：已有任务在跑时拒绝，并给出当前 jobId（不排队）', () => {
  const s = store();
  const first = s.create({ instruction: 'a' });
  const second = s.create({ instruction: 'b' });
  assert.equal(second.ok, false, '第二个任务必须被拒绝');
  assert.equal(second.runningJobId, first.job.id);
  assert.match(second.error, /同时只能跑一个/, '应说明为什么（并发会互相踩标签页）');
  assert.match(second.error, /jobId=/, '应给出当前 jobId 便于查进度');
});

test('create：上一个结束后可以再开新任务（拒绝的是并发，不是后续任务）', () => {
  const s = store();
  const a = s.create({});
  s.finish(a.job.id, JOB_STATE.COMPLETED, { result: 'done' });
  const b = s.create({});
  assert.equal(b.ok, true, '前一个结束后应当能开新的');
});

test('append：seq 单调递增，保序', () => {
  const s = store();
  const { job } = s.create({});
  s.append(job.id, { type: 'chunk', text: '一' });
  s.append(job.id, { type: 'tool-call', name: 'click_element' });
  s.append(job.id, { type: 'end' });
  const r = s.read(job.id, 0);
  assert.deepEqual(r.events.map((e) => e.seq), [1, 2, 3]);
  assert.deepEqual(r.events.map((e) => e.type), ['chunk', 'tool-call', 'end']);
});

test('read：按游标只返回增量，不重复不丢（轮询的核心语义）', () => {
  const s = store();
  const { job } = s.create({});
  s.append(job.id, { type: 'a' });
  s.append(job.id, { type: 'b' });
  const first = s.read(job.id, 0);
  assert.equal(first.events.length, 2);
  assert.equal(first.seq, 2);

  s.append(job.id, { type: 'c' });
  const second = s.read(job.id, first.seq);
  assert.deepEqual(second.events.map((e) => e.type), ['c'], '只应拿到新增的那条');
  assert.equal(second.seq, 3);

  // 没有新事件时：空数组 + seq 不变（调用方据此决定是否继续轮询）
  const third = s.read(job.id, second.seq);
  assert.deepEqual(third.events, []);
  assert.equal(third.seq, 3);
});

test('read：job 不存在返回 null（而不是抛异常或给一个空壳）', () => {
  const s = store();
  assert.equal(s.read('nope'), null);
});

test('read：running 字段让调用方不必自己解释 state', () => {
  const s = store();
  const { job } = s.create({});
  assert.equal(s.read(job.id, 0).running, true);
  s.finish(job.id, JOB_STATE.COMPLETED, { result: '好了' });
  const after = s.read(job.id, 0);
  assert.equal(after.running, false);
  assert.equal(after.state, JOB_STATE.COMPLETED);
  assert.equal(after.result, '好了');
});

test('write 后 finish：失败任务保留 error，且不再 running', () => {
  const s = store();
  const { job } = s.create({});
  s.finish(job.id, JOB_STATE.FAILED, { error: '未配置 API Key' });
  const r = s.read(job.id, 0);
  assert.equal(r.state, JOB_STATE.FAILED);
  assert.equal(r.error, '未配置 API Key');
  assert.equal(r.running, false);
});

test('事件超上限：丢最旧的，并把 omitted 暴露出来（不许静默给一段看起来连续的日志）', () => {
  const s = store({ eventLimit: 3 });
  const { job } = s.create({});
  for (let i = 1; i <= 5; i += 1) s.append(job.id, { type: 't' + i });
  const r = s.read(job.id, 0);
  assert.deepEqual(r.events.map((e) => e.type), ['t3', 't4', 't5'], '应保留最新的');
  assert.equal(r.omitted, 2, '丢了多少必须让读取方知道');
});

test('事件超上限后，游标语义仍然成立（不会因为丢弃而重复投递）', () => {
  const s = store({ eventLimit: 2 });
  const { job } = s.create({});
  s.append(job.id, { type: 'a' });
  s.append(job.id, { type: 'b' });
  const r1 = s.read(job.id, 0);
  s.append(job.id, { type: 'c' }); // 触发丢弃 a
  const r2 = s.read(job.id, r1.seq);
  assert.deepEqual(r2.events.map((e) => e.type), ['c'], '只应拿到 c，不该把 b 再投一次');
});

test('prune：保留上限生效，但绝不丢在跑的 job', () => {
  const s = store({ keep: 2 });
  const running = s.create({ instruction: '长任务' });
  // 造几个已结束的 job 把上限撑爆
  for (let i = 0; i < 3; i += 1) {
    const j = s.create({ instruction: 'x' + i });
    if (!j.ok) break; // 有 running 时会被拒，这是预期
    s.finish(j.job.id, JOB_STATE.COMPLETED);
  }
  // 无论怎么裁剪，在跑的那个必须还在
  assert.ok(s.get(running.job.id), '在跑的 job 绝不能被裁掉');
});

test('requestCancel：标记后仍在 running（真正终止由扩展侧响应 AbortSignal 完成）', () => {
  const s = store();
  const { job } = s.create({});
  const j = s.requestCancel(job.id);
  assert.equal(j.cancelRequested, true);
  assert.equal(s.read(job.id, 0).running, true, '取消是异步的，不能假装已经停了');
});

test('running()：多个已结束 job 不会误报有任务在跑', () => {
  const s = store();
  const a = s.create({});
  s.finish(a.job.id, JOB_STATE.CANCELLED);
  assert.equal(s.running(), null);
});

// ---------------- 结果回传：任务成功必须能拿到答复 ----------------
//
// agent 的答复是一串 {type:'chunk', text} 流式发出来的，而事件缓冲有上限。
// 一个跑了几十步的任务，最后那段答复完全可能把前面的 chunk 挤掉 ——
// 若只依赖"答复还在事件里"，调用方会拿到 state=completed 但 result 为空。

test('finalAnswerFrom：取最后一段连续 chunk，而不是把所有 chunk 拼起来', () => {
  const events = [
    { type: 'chunk', text: '先看一下页面……' },
    { type: 'tool-call', name: 'get_page_snapshot' },
    { type: 'tool-result', name: 'get_page_snapshot' },
    { type: 'chunk', text: '已经填好了' },
    { type: 'chunk', text: '，标题是「测试」。' },
    { type: 'end' },
  ];
  assert.equal(
    finalAnswerFrom(events),
    '已经填好了，标题是「测试」。',
    '应只取最后一段连续 chunk —— 把过程里的解释也拼进来会把「过程」当成「结论」'
  );
});

test('finalAnswerFrom：答复之后还跟着收尾元数据时，仍然拿得到答复（真实流的形状）', () => {
  // 这条来自一次真实浏览器 E2E 的实测：线上表现为"任务成功但拿不到答复"，
  // 而当时的单测是绿的 —— 因为假事件流结尾恰好没有这些元数据。
  // 真实结尾（实测）：chunk("。") → usage → agent-state(completed) → end
  const events = [
    { type: 'chunk', text: '这个页面是用于' },
    { type: 'chunk', text: '探活的。' },
    { type: 'usage', totalTokens: 28404 },
    { type: 'agent-state', state: 'completed', step: 2 },
    { type: 'end' },
  ];
  assert.equal(
    finalAnswerFrom(events),
    '这个页面是用于探活的。',
    '收尾元数据（usage / agent-state / end）不得让答复丢失 —— 它们排在答复之后是常态'
  );
});

test('finalAnswerFrom：夹杂 reasoning 时不会把推理当成答复', () => {
  // reasoning 是模型的思考流，混进答复里会把"过程"当"结论"。
  const events = [
    { type: 'reasoning', text: '让我想想……' },
    { type: 'chunk', text: '答复。' },
  ];
  assert.equal(finalAnswerFrom(events), '答复。');
});

test('finalAnswerFrom：没有 chunk / 空输入都返回空串，不抛异常', () => {
  assert.equal(finalAnswerFrom([{ type: 'end' }]), '');
  assert.equal(finalAnswerFrom([]), '');
  assert.equal(finalAnswerFrom(null), '');
});

test('finish(COMPLETED) 且调用方没给 result 时，自动从事件里捞最终答复', () => {
  const s = store();
  const { job } = s.create({});
  s.append(job.id, { type: 'chunk', text: '任务完成：' });
  s.append(job.id, { type: 'chunk', text: '已发布。' });
  s.append(job.id, { type: 'end' });
  s.finish(job.id, JOB_STATE.COMPLETED);
  const r = s.read(job.id, 0);
  assert.equal(r.state, JOB_STATE.COMPLETED);
  assert.equal(r.result, '任务完成：已发布。', '成功结束必须能读到答复，否则调用方只看到 completed 而拿不到内容');
});

test('finish(COMPLETED) 时调用方显式给的 result 优先于从事件里捞的', () => {
  const s = store();
  const { job } = s.create({});
  s.append(job.id, { type: 'chunk', text: '流式文本' });
  s.finish(job.id, JOB_STATE.COMPLETED, { result: '显式结果' });
  assert.equal(s.read(job.id, 0).result, '显式结果');
});

test('答复即使超出事件上限也仍能回传（这正是必须单独固化的理由）', () => {
  const s = store({ eventLimit: 2 });
  const { job } = s.create({});
  s.append(job.id, { type: 'chunk', text: '关' });
  s.append(job.id, { type: 'chunk', text: '键' });
  s.append(job.id, { type: 'chunk', text: '答' });
  s.append(job.id, { type: 'chunk', text: '复' }); // 触发丢弃前两条
  s.finish(job.id, JOB_STATE.COMPLETED);
  const r = s.read(job.id, 0);
  assert.equal(r.omitted, 2, '前两条确实被丢了');
  assert.equal(r.result, '答复', '即便事件被裁剪，答复仍必须能拿到（否则长任务的结果就是空的）');
});

test('失败/取消时不去捞答复（那不是"结果"，别把过程文字当成结论）', () => {
  const s = store();
  const { job } = s.create({});
  s.append(job.id, { type: 'chunk', text: '正在尝试……' });
  s.finish(job.id, JOB_STATE.FAILED, { error: '炸了' });
  const r = s.read(job.id, 0);
  assert.equal(r.result, '', '失败时不应把过程文字当结果');
  assert.equal(r.error, '炸了');
});

// ---------------- 卡住的任务必须有个终态 ----------------
//
// 扩展侧等审批是挂在 port 上的、**没有超时兜底**（客户端那 60s/90s 只约束单次调用，
// 管不到已经启动的长任务）。不判 stalled 的话，job 会永远停在 running，
// 调用方一直轮询却永远等不到终态，而且**看不出**这是"卡住"还是"还在干活"。

/** 可注入时钟的 store，便于直测"卡住"（真实时钟要等 90 秒没法测）。 */
function clockStore(opts = {}) {
  let t = 1000000;
  const s = new AgentJobStore(Object.assign({ stallMs: 1000, now: () => t }, opts));
  return { s, advance: (ms) => { t += ms; }, at: () => t };
}

test('reapStale：长时间没有新事件的在跑任务被判定为 stalled，并给出原因', () => {
  const { s, advance } = clockStore();
  const { job } = s.create({ instruction: '发一条内容' });
  advance(1001);
  const reaped = s.reapStale();
  assert.equal(reaped.length, 1, '超时未动的任务应被收割');
  const r = s.read(job.id, 0);
  assert.equal(r.state, JOB_STATE.STALLED);
  assert.equal(r.running, false, '必须变得不再 running，否则调用方会继续轮询');
  assert.match(r.error, /没有任何进展/, '应说明为什么被判定卡住');
  assert.match(r.error, /审批|无响应/, '应指出常见原因，便于归因');
  assert.match(r.error, /agent_task_cancel/, '应给出下一步能做什么');
});

test('reapStale：有新事件进账的任务不会被误判（长任务不该被当成卡住）', () => {
  const { s, advance } = clockStore();
  const { job } = s.create({});
  for (let i = 0; i < 5; i += 1) {
    advance(900); // 每次都在阈值内
    s.append(job.id, { type: 'chunk', text: 'x' });
    s.reapStale();
  }
  assert.equal(s.read(job.id, 0).state, JOB_STATE.RUNNING, '持续有进展的任务必须保持 running（不构成进度墙）');
});

test('reapStale：已结束的任务不受影响', () => {
  const { s, advance } = clockStore();
  const a = s.create({});
  s.finish(a.job.id, JOB_STATE.COMPLETED, { result: '好了' });
  advance(99999);
  assert.deepEqual(s.reapStale(), [], '已结束的任务不该被收割');
  assert.equal(s.read(a.job.id, 0).state, JOB_STATE.COMPLETED, '终态不得被改写成 stalled');
});

test('reapStale：收割后能开新任务（卡住的不会永久占住串行槽）', () => {
  const { s, advance } = clockStore();
  s.create({});
  assert.equal(s.create({}).ok, false, '有任务在跑时应拒绝并发');
  advance(1001);
  s.reapStale();
  assert.equal(s.create({}).ok, true, '卡住的任务被收割后应当能开新的（否则串行槽被永久占死）');
});

test('reapStale 的错误信息里秒数是真实的闲置时长（不是 0）', () => {
  // 这条钉一个很容易写错的细节：若先改写 updatedAt 再算差值，得到的是 0。
  const { s, advance } = clockStore();
  const { job } = s.create({});
  advance(3000);
  s.reapStale();
  const r = s.read(job.id, 0);
  assert.match(r.error, /3s/, '应报告真实的闲置时长；写成 0s 说明算差值时更新了 updatedAt');
});
