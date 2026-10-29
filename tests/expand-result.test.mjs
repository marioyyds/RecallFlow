// A5：验证「大结果 → 截断通知带 id → 历史折叠后 id 仍在 → expand_result 取回全文」整条链路。
//
// ## 为什么值得单独钉
//
// 这条链路**跨两个模块**：`agent.js` 生成通知文本，`context.js` 用**正则**从通知里抠 id
// （折叠旧工具结果时要把 id 重写进摘要）。两边任何一处改了措辞，id 就**静默消失** ——
// 而症状只是"模型没去取全文"，看起来像它偷懒，实际是链接断了。
//
// `context.js` 的注释记录过历史上真出过这个问题（"全文还在，模型却再也拿不到 id"）。
// 本轮把它变成一条**用真实字符串**跑的用例，并让通知格式只有一个来源
//（`agent.js` 的 `formatTruncationNotice`）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { collapseOldToolResults } from '../lib/application/agent/context.ts';
import { expandResult } from '../lib/application/agent/run-state-tools.ts';
import { formatTruncationNotice } from '../lib/application/agent/agent.ts';

/** 造一个"大结果已被截断"的 tool 消息（用**真实的**通知格式）。 */
function truncatedToolMessage(totalChars, id) {
  return { role: 'tool', tool_call_id: 'call-1', content: 'A'.repeat(3000) + formatTruncationNotice(totalChars, id) };
}

const FULL = 'B'.repeat(9000);
const ctx = () => ({ resultStore: new Map([['res-12', FULL]]), resultIds: new Set(['res-12']) });

test('① 截断通知里必须带 id，且写明"可用 expand_result 取回"', () => {
  const n = formatTruncationNotice(9000, 'res-12');
  assert.match(n, /id=res-12/, '要带 id');
  assert.match(n, /expand_result/, '要告诉模型取回手段');
  assert.match(n, /已截断/, '要说明当前内容是截断的');
  assert.match(n, /9000/, '要给出原始长度（判断值不值得取）');
});

test('② 历史折叠后 id **仍在**（这是 A5 的核心：折叠不能吃掉可恢复性）', () => {
  const messages = [truncatedToolMessage(9000, 'res-12')];
  const collapsed = collapseOldToolResults(messages, 0, 300, 150); // keepFull=0 → 这条必然被折叠
  assert.equal(collapsed, 1, '前置：这条应当被折叠（否则本用例没验到东西）');
  const text = messages[0].content;
  assert.ok(text.length < 3600, '折叠后应当明显变短');
  assert.match(text, /id=res-12/, '折叠后的摘要**必须**带上 id —— 丢了它，全文就再也取不回');
  assert.match(text, /expand_result/, '并要告诉模型怎么取回');
  assert.match(text, /全文未丢失/, '要明确说全文没丢（否则模型不会去取）');
});

test('③ 顺着折叠后的 id 真的能把全文取回来（链路可达）', () => {
  const messages = [truncatedToolMessage(9000, 'res-12')];
  collapseOldToolResults(messages, 0, 300, 150);
  const id = (messages[0].content.match(/id=(res-[A-Za-z0-9_-]+)/) || [])[1];
  assert.ok(id, '要能从折叠后的文本里取出 id');
  const r = expandResult(ctx(), { id, limit: 4000 });
  assert.equal(r.ok, true, '应当取回成功');
  assert.match(r.result, /共 9000 字符/, '要报出全文长度');
  assert.ok(r.result.includes(FULL.slice(0, 100)), '返回的应当是**真的全文**（不是摘要）');
});

test('④ 分页取回：offset/limit 生效，limit 被夹在合理区间', () => {
  const c = ctx();
  const first = expandResult(c, { id: 'res-12', offset: 0, limit: 2000 });
  assert.match(first.result, /\[0,2000\)/, '要回报实际区间');
  const second = expandResult(c, { id: 'res-12', offset: 2000, limit: 2000 });
  assert.match(second.result, /\[2000,4000\)/);
  assert.notEqual(first.result, second.result, '不同区间必须是不同内容');
  // limit 下界 200 / 上界 4000
  assert.match(expandResult(c, { id: 'res-12', limit: 1 }).result, /\[0,200\)/, '过小的 limit 应被夹到 200');
  assert.match(expandResult(c, { id: 'res-12', limit: 999999 }).result, /\[0,4000\)/, '过大的 limit 应被夹到 4000');
  // 越界 offset 返回空片，但仍是 ok（可读的边界行为，不是错误）
  const past = expandResult(c, { id: 'res-12', offset: 9999 });
  assert.equal(past.ok, true);
  assert.match(past.result, /共 9000 字符/, '越界时仍要报出真实长度，便于模型纠正');
});

test('⑤ 两类"没取到"必须分开说（否则模型会反复重试同一个 id 空耗）', () => {
  const unknown = expandResult({ resultStore: new Map(), resultIds: new Set() }, { id: 'res-99' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.result, /请确认 id 是否正确/, '陌生 id 要提示可能记错');

  const fromPrevRun = expandResult({ resultStore: new Map(), resultIds: new Set(['res-99']) }, { id: 'res-99' });
  assert.equal(fromPrevRun.ok, false);
  assert.match(fromPrevRun.result, /上一轮运行/, '属于上一轮的要说明"内容已释放"，并让模型改走重新读页面');
});

test('⑥ 跨模块的格式耦合必须有单一来源（防止改成一处、另一处静默失效）', () => {
  const [agentSrc, pipelineSrc] = [
    'lib/application/agent/agent-messages.ts',
    'lib/application/agent/tool-call-pipeline.ts',
  ].map((file) => fs.readFileSync(file, 'utf8'));
  const ctxSrc = fs.readFileSync('lib/application/agent/context.ts', 'utf8');
  assert.match(agentSrc, /export function formatTruncationNotice/, '通知格式要由本函数提供');
  assert.match(pipelineSrc, /formatTruncationNotice\(result\.result\.length, resultId\)/, '截断处必须用它，不许再手拼字符串');
  // context.js 仍然靠正则解析这条通知 —— 这正是需要"单一来源 + 用真实字符串测"的原因
  assert.match(ctxSrc, /ID_NOTICE_RE/, 'context.js 仍会解析通知里的 id');
  // 真字符串必须能被 context.js 的正则认出来（等价于 §② 的断言，但直接盯正则）
  const notice = formatTruncationNotice(9000, 'res-12');
  const m = /\n…（结果共[^）]*id=(res-[A-Za-z0-9_-]+)[^）]*）\s*$/.exec('A'.repeat(3000) + notice);
  assert.ok(m && m[1] === 'res-12', 'context.js 那条正则必须能认出**当前**通知格式');
});

test('⑦ 这条门禁本身有牙齿：通知格式一变，折叠就该丢掉 id（说明用例真的在盯耦合）', () => {
  // 模拟"有人改了通知措辞"：同样带 id，但不是 context.js 认得的形态
  const changed = '\n【结果太长】完整内容编号 res-12，可用 expand_result 读取';
  const messages = [{ role: 'tool', tool_call_id: 'c', content: 'A'.repeat(3000) + changed }];
  collapseOldToolResults(messages, 0, 300, 150);
  assert.ok(
    !/id=res-12/.test(messages[0].content),
    '措辞一改，折叠后的摘要就带不上 id —— 这正是 §② 要防的事故（本用例证明它确实会发生）'
  );
});
