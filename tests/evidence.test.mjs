// 完成前校验的「证据选择」。
//
// 实测缺陷：一次「提炼关键要点」任务页面 10398 字，校验方只拿到前 2500 字（永远是开头），
// 而结论依据的提交哈希散落在页面深处 —— 校验方按「证据不足即判未达成」否决，
// agent 只好用 5 次调用重新取证（2× expand_result + 2× checkTexts + 1× highlight_text）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { selectEvidence, extractClaimTokens, EVIDENCE_BUDGET } from '../lib/assistant/evidence.js';

/** 造一个「关键事实在深处」的长页面，模拟真实场景。 */
function longPage({ head = 3000, mid = 2500, tail = 1500 } = {}) {
  return (
    '工作区bookmark-sorterMCP SDK package missing error5分钟'.repeat(Math.ceil(head / 24)).slice(0, head) +
    'X'.repeat(mid) +
    '\n两项都改完，已提交 5992e10（4 个文件，+240 / -8），639 项测试全绿（623 → +16）\n' +
    'Y'.repeat(mid) +
    '\n已提交 c2fdddc（6 个文件，+209 / -31），652 项测试全绿（639 → +13）\n' +
    'Z'.repeat(tail) +
    '\n页面结束'
  );
}

test('extractClaimTokens: 抽出哈希 / 标识符 / 多位数字', () => {
  const t = extractClaimTokens('已提交 5992e10，改了 resultProgressByChange，测试 623 项');
  assert.ok(t.includes('5992e10'), '提交哈希要抽出来');
  assert.ok(t.includes('resultProgressByChange'), '标识符要抽出来');
  assert.ok(t.includes('623'), '多位数字要抽出来');
});

test('extractClaimTokens: 单个数字不算（噪声太大）', () => {
  const t = extractClaimTokens('有 1 个问题，第 2 步');
  assert.ok(!t.includes('1'), '单个数字不应作为检索词');
  assert.ok(!t.includes('2'));
});

test('extractClaimTokens: 空输入与脏数据安全', () => {
  assert.deepEqual(extractClaimTokens(''), []);
  assert.deepEqual(extractClaimTokens(null), []);
  assert.equal(typeof extractClaimTokens(undefined), 'object');
});

test('selectEvidence: 关键事实在深处也能被选中（这正是不再取开头的原因）', () => {
  const page = longPage();
  const claim = '两轮修复：5992e10、c2fdddc；测试 623→639→652';
  const r = selectEvidence({ fullText: page, claim });
  assert.ok(r.text.includes('5992e10'), '提交哈希必须在证据里');
  assert.ok(r.text.includes('c2fdddc'), '第二个提交也必须在证据里');
  // 旧行为：取开头 2500 字
  assert.ok(!page.slice(0, 2500).includes('5992e10'), '前提校验：旧行为确实看不到这个事实');
});

test('selectEvidence: 用更少的字覆盖到事实（不是靠把窗口开大）', () => {
  const page = longPage();
  const r = selectEvidence({ fullText: page, claim: '两轮修复：5992e10、c2fdddc' });
  assert.ok(r.text.length <= EVIDENCE_BUDGET + 400, '应受预算约束，实际 ' + r.text.length);
  assert.ok(r.text.length < page.length / 2, '不应把大半页塞进去，实际 ' + r.text.length + '/' + page.length);
});

test('selectEvidence: 页头与页尾都要保留（页面形状 + 结论常在末尾）', () => {
  const page = longPage();
  const r = selectEvidence({ fullText: page, claim: '两轮修复：5992e10' });
  assert.ok(r.text.startsWith('工作区bookmark-sorter'), '页头应在，用于辨认是什么页面');
  assert.ok(r.text.includes('页面结束'), '页尾应在，结论与最新状态常在末尾');
});

test('selectEvidence: 预算不足时优先保页尾而不是丢掉它', () => {
  // 命中片段很多、预算很紧时，页尾最容易被静默丢弃 —— 恰是最该看的一段
  const page = '头'.repeat(200) + ('命中关键词AAAAAAAAAA'.repeat(60)) + '尾'.repeat(200);
  const r = selectEvidence({ fullText: page, claim: '关键', budget: 600 });
  assert.ok(r.text.includes('尾'), '预算紧张时页尾仍应在：' + JSON.stringify(r.text.slice(-80)));
});

test('selectEvidence: 覆盖率标注必须说明「这是片段」并阻止「没出现即编造」的推断', () => {
  const r = selectEvidence({ fullText: longPage(), claim: '两轮修复：5992e10' });
  assert.match(r.coverage, /取自 \d+ 字正文/);
  assert.match(r.coverage, /未列出的部分不代表不存在/);
  assert.match(r.coverage, /不能仅凭/, '必须明确禁止「证据里没有 X 就判 X 编造」');
});

test('selectEvidence: 统计未找到的具体事实（供校验方区分「没找到」与「矛盾」）', () => {
  const page = longPage();
  const r = selectEvidence({ fullText: page, claim: '提交 deadbeef1234 与 5992e10' });
  assert.ok(r.hitTokens.includes('5992e10'));
  assert.ok(r.missedTokens.includes('deadbeef1234'), '正文里没有的事实要单独报告');
  assert.match(r.coverage, /未找到/);
});

test('selectEvidence: 到处都是的高频词不用于检索（定位不到任何东西）', () => {
  const page = 'AAAA'.repeat(500) + '结论在末尾';
  const r = selectEvidence({ fullText: page, claim: 'AAAA 是高频词' });
  // AAAA 出现 500 次 > 阈值 → 不作为检索词；没有检索词时只剩页头 + 页尾
  assert.ok(r.hitTokens.length === 0, '高频词不应被当作命中，实际 ' + r.hitTokens.join(','));
});

test('selectEvidence: 没有全文时退回旧行为，但仍标注「只是开头片段」', () => {
  const r = selectEvidence({ fullText: '', fallback: '页面正文开头……', claim: '5992e10' });
  assert.match(r.text, /页面正文开头/);
  assert.match(r.coverage, /开头片段/);
  assert.match(r.coverage, /不代表不存在/);
});

test('selectEvidence: 预算被遵守（含省略号标记）', () => {
  for (const budget of [500, 1200, EVIDENCE_BUDGET]) {
    const r = selectEvidence({ fullText: longPage(), claim: '5992e10 c2fdddc 623 639 652', budget });
    assert.ok(r.text.length <= budget + 300, 'budget=' + budget + ' 实际 ' + r.text.length);
  }
});

test('selectEvidence: 脏数据与极短文本安全', () => {
  assert.doesNotThrow(() => selectEvidence());
  assert.doesNotThrow(() => selectEvidence({ fullText: null, claim: null }));
  const tiny = selectEvidence({ fullText: '短', claim: '5992e10' });
  assert.equal(tiny.text, '短');
  assert.ok(!tiny.text.includes('undefined'));
});

test('selectEvidence: 片段有省略号标记，读者能看出中间被跳过', () => {
  const r = selectEvidence({ fullText: longPage(), claim: '5992e10' });
  assert.ok(r.text.includes('…'), '跳过的部分必须有省略标记，否则看起来像连续文本');
});
