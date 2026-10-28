// 历史折叠：长工具结果的**中段**会消失 —— 必须说清"哪里去了、该怎么办"。
//
// ## 起因（一次真实的排查）
//
// 日期选择器的 E2E 里，「已订满」怎么都进不了上下文。我先给了"快照采集把视口外元素裁掉"的
// 解释，并用**预测检验**（先 scroll_page 滚进视口再读）把它**推翻**了 ✗
//
// 本文件钉住的是另一个机制（**机制本身确信，是否就是那次现象的原因需另行验证**）：
// `collapseOldToolResults` 会把**靠前的**长工具结果折叠成 **开头 300 + 通知 + 结尾 150**，
// 中段直接丢弃。而快照 JSON 的**中段**正是日历格子那些标签所在的位置。
//
// 更要紧的是：**没有 id 时中段取不回原文**（只有被 agent 截断的大结果才进 resultStore），
// 而原来的通知只说"共 N 字符，此处保留开头与结尾" ✗ ——
// 模型看不出"哪一段没了、我该做什么"，于是会以为"页面里本来就没有这些" ✗
import test from 'node:test';
import assert from 'node:assert/strict';

import { collapseOldToolResults, buildCollapsed } from '../lib/application/agent/context.ts';

// ⚠ 必须**明显超过** headLen + tailLen + 40（默认 300 + 150 + 40 = 490），
// 否则 buildCollapsed 会判定"头尾本来就够短"而**原样返回**（第一版测试就栽在这儿 ✗）。
const HEAD = 'H'.repeat(600);
const MID = '{"label":"3月14日（已订满）"}';
const TAIL = 'T'.repeat(600);
const LONG = HEAD + '……' + MID + '……' + TAIL;

test('折叠后**中段消失**（这是机制本身，先钉住它）', () => {
  const out = buildCollapsed(LONG, 300, 150);
  assert.ok(out.length < LONG.length, '应当更短');
  assert.ok(out.includes(HEAD.slice(0, 50)), '开头保留');
  assert.ok(out.includes(TAIL.slice(-30)), '结尾保留');
  assert.ok(!out.includes(MID), '中段被丢弃 —— 这就是"标签看不到"的机制');
});

test('没有 id 时必须说明：中段取不回、以及**下一步该做什么**', () => {
  const out = buildCollapsed(LONG, 300, 150);
  assert.match(out, /中段内容已省略且取不回原文/, '要明说取不回（否则模型以为还能 expand）');
  assert.match(out, /重新调用/, '要给出下一步：重新调用产生它的工具');
  assert.match(out, /maxElements|maxText|滚动/, '并顺带给缩小范围的办法');
  assert.ok(!/expand_result/.test(out), '没有 id 时不该提 expand_result（那会引向无效操作）');
});

test('有 id 时仍走"全文未丢失 + expand_result"那条（别把可恢复的说成不可恢复）', () => {
  const withId = LONG + '\n…（结果共 9000 字符，已截断；完整内容 id=res-12，可用 expand_result(id="res-12") 分段读取）';
  const out = buildCollapsed(withId, 300, 150);
  assert.match(out, /全文未丢失/);
  assert.match(out, /expand_result\(id="res-12"\)/);
  assert.ok(!/取不回原文/.test(out), '可恢复的不该说成不可恢复');
});

test('这两个分支必须互斥（同时出现会自相矛盾）', () => {
  const withId = LONG + '\n…（结果共 9000 字符，已截断；完整内容 id=res-12，可用 expand_result(id="res-12") 分段读取）';
  const a = buildCollapsed(withId, 300, 150);
  const b = buildCollapsed(LONG, 300, 150);
  assert.notEqual(/取不回原文/.test(a), /取不回原文/.test(b), '一个有一个没有');
});

test('折叠按位置生效：只有**靠前的**长结果会被折叠（keepFull 之内保持完整）', () => {
  const msgs = [];
  for (let i = 0; i < 8; i++) msgs.push({ role: 'tool', tool_call_id: 'c' + i, content: i === 0 ? LONG : 'short' + i });
  const collapsed = collapseOldToolResults(msgs, 6, 300, 150);
  assert.ok(collapsed >= 1, '第 1 条（8 - keepFull 6 = 前 2 条之内）应当被折叠');
  assert.ok(!msgs[0].content.includes(MID), '它正是那条中段消失的结果');
  assert.equal(msgs[7].content, 'short7', '最后一条不受影响');
});

test('这条门禁本身有牙齿：旧的"只说保留头尾"文案必须判为不合格', () => {
  const guilty = (s) => !/取不回原文/.test(s) && !/全文未丢失/.test(s);
  assert.equal(guilty('【已折叠】共 900 字符，此处保留开头与结尾'), true, '旧写法要被抓');
  assert.equal(guilty(buildCollapsed(LONG, 300, 150)), false, '当前实现不该被抓');
});
