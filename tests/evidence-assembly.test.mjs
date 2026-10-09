// 证据装配：动作回执 + 页面片段必须**同时**在场。
//
// 这是修过一次的回归 —— 上一轮把证据改成「按结论定位页面片段」后，
// selectEvidence 在没有 fullText 时才用 fallback，于是有全文时
// ctx.lastEvidence（动作回执：「已高亮 12 / 12 处关键信息」）被整个挤掉。
// 校验方看不到「刚做了什么」，就怀疑高亮是否真的存在，agent 又花十几次调用自证。
//
// 教训很具体：selectEvidence 与 evidenceAfter 各自都有测试，但两者在
// runCompletionVerification 里的**组合**没有测试。这里补的就是那条装配性质。
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildVerificationEvidence } from '../lib/assistant/agent.js';

const receipt = '【最近一次页面动作】highlight_text（已执行成功）\n参数：{"texts":["甲","乙"]}\n返回：已高亮 12 / 12 处关键信息';

/** 长页面：关键事实在深处 */
const longPage =
  '页面标题：T\n页面URL：http://x/\n正文约 12000 字\n\n当前页面正文：\n' +
  '导航'.repeat(1200) +
  '\n已提交 1389044（5 个文件，+492 / −13），676 项测试全绿（652 → +24）\n' +
  '正文'.repeat(800) +
  '\n页面结束';

test('有全文时，动作回执不能被页面片段挤掉（本次回归的直接成因）', () => {
  const ev = buildVerificationEvidence({ lastEvidence: receipt, lastReadFullText: longPage }, '已提交 1389044，676 项测试全绿');
  assert.match(ev, /已高亮 12 \/ 12 处关键信息/, '回执必须在场 —— 校验方据此确认「刚做了什么」');
  assert.match(ev, /最近一次动作的回执/, '回执要有来源标注');
});

test('同一份证据里也要有页面片段（校验方据此判断结论与页面是否一致）', () => {
  const ev = buildVerificationEvidence({ lastEvidence: receipt, lastReadFullText: longPage }, '已提交 1389044，676 项测试全绿');
  assert.match(ev, /页面相关片段/);
  assert.match(ev, /1389044/, '结论引用的具体事实要能被校验方看到');
});

test('没有全文时也不能丢回执（退回旧路径）', () => {
  const ev = buildVerificationEvidence({ lastEvidence: receipt, lastReadFullText: '' }, '随便');
  assert.match(ev, /已高亮 12 \/ 12 处关键信息/);
});

test('页面快照在场时一并附上，且三部分都带来源标注', () => {
  const snap = { title: 'T', url: 'http://x/', text: '正文摘要', elements: [{ ref: 'rf-1', label: '按钮' }] };
  const ev = buildVerificationEvidence({ lastSnapshot: snap, lastEvidence: receipt, lastReadFullText: longPage }, '1389044');
  assert.match(ev, /页面标题：T/, '快照摘要应在');
  assert.match(ev, /最近一次动作的回执/);
  assert.match(ev, /页面相关片段/);
});

test('覆盖率标注必须保留（否则校验方会高估证据完整度）', () => {
  const ev = buildVerificationEvidence({ lastEvidence: receipt, lastReadFullText: longPage }, '1389044');
  assert.match(ev, /未列出的部分不代表不存在/);
});

test('回执很长时不挤占页面片段的额度', () => {
  const huge = 'x'.repeat(20000);
  const ev = buildVerificationEvidence({ lastEvidence: huge, lastReadFullText: longPage }, '1389044');
  assert.ok(ev.length < 20000, '不能把 20k 的回执原样塞进去，实际 ' + ev.length);
  assert.match(ev, /页面相关片段/, '回执被截断后仍要给页面片段留位置');
});

test('脏数据安全', () => {
  assert.doesNotThrow(() => buildVerificationEvidence({}, ''));
  assert.doesNotThrow(() => buildVerificationEvidence({ lastEvidence: null, lastReadFullText: null }, null));
  assert.equal(typeof buildVerificationEvidence({}, ''), 'string');
});
