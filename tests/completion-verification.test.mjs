// 完成前校验的判据分级与证据接线。
//
// 背景：一次「提炼关键要点」任务（页面 10398 字）里校验方否决了正确的结论，理由是
// 「证据里没有那些提交哈希」—— 而它只拿到了页面前 2500 字。根因有两个，各自钉住：
//   ① 证据是固定窗口（永远是开头）→ 改为按结论里的具体事实定位片段；
//   ② 提示词自相矛盾：既说「证据可能不完整」，又说「证据不足则判 false」——
//      对长页面前半句恒真、后半句恒触发，纯阅读类任务必然被误否。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { VERIFIER_SYSTEM } from '../lib/assistant/verifier.js';

// ---------------------------------------------------------------- 提示词判据

test('提示词区分两类任务，判据不同', () => {
  assert.match(VERIFIER_SYSTEM, /mutation/, '缺少「有写操作」一类');
  assert.match(VERIFIER_SYSTEM, /read/, '缺少「纯阅读」一类');
  assert.match(VERIFIER_SYSTEM, /两类任务性质|两类的判据不同|任务性质/, '要明确说明两类判据不同');
});

test('纯阅读类的判据是「矛盾/无据」，不是「证据能否覆盖全部细节」', () => {
  assert.match(VERIFIER_SYSTEM, /具体矛盾/, '要允许「指出具体矛盾」才判否');
  assert.match(VERIFIER_SYSTEM, /一致性与依据|一致/, '阅读类判据应是一致性与依据');
});

test('提示词明确禁止「证据里没出现 X 就判 X 是编造的」', () => {
  // 这正是本次误否的直接触发条件
  assert.match(VERIFIER_SYSTEM, /不要\*\*?因为「证据里没有出现/, '必须显式禁止这种推断');
  assert.match(VERIFIER_SYSTEM, /片段/, '要说明证据是片段、不是全文');
  // 措辞必须与证据里的覆盖率标注一致 —— 校验方是在那段标注旁边读到这句话的
  assert.match(VERIFIER_SYSTEM, /未列出的部分不代表不存在/, '要说明未列出不等于不存在');
});

test('提示词禁止用页面标题推断页面状态（实测被「MCP SDK package missing error」带偏）', () => {
  assert.match(VERIFIER_SYSTEM, /不要用「页面标题」推断页面状态/);
  assert.match(VERIFIER_SYSTEM, /会话名/, '要说明标题常常只是会话名');
  assert.match(VERIFIER_SYSTEM, /MCP SDK package missing error/, '要给出实测反例，否则模型仍会凭直觉判断');
});

test('提示词保留既有的「可见性不能用关键词否定」规则', () => {
  assert.match(VERIFIER_SYSTEM, /可见性证据/);
  assert.match(VERIFIER_SYSTEM, /textContent/);
});

test('提示词保留「不要因为 Agent 说完成就采信」', () => {
  assert.match(VERIFIER_SYSTEM, /不要因为 Agent 说/);
});

// ---------------------------------------------------------------- agent 接线
//
// 这几条是「某条代码路径少做一步」型缺陷：接线漏了不会报错、测试也不红，
// 只是长页面任务又开始被误否。因此按源码级门禁钉住（与既有做法一致）。

const src = fs.readFileSync('lib/assistant/agent.js', 'utf8');
const lines = src.split('\n').map((l) => l.replace(/\r$/, ''));

function indexOfLine(pattern, from = 0) {
  const i = lines.findIndex((l, idx) => idx >= from && l.includes(pattern));
  assert.notEqual(i, -1, '找不到：' + pattern);
  return i;
}
function sliceBetween(startMarker, endMarker) {
  const s = indexOfLine(startMarker);
  const e = indexOfLine(endMarker, s + 1);
  return lines.slice(s, e).join('\n');
}

test('expand_result 必须算作读类证据（模型读到的内容不能被排除）', () => {
  const block = sliceBetween('const EVIDENCE_READ_TOOLS', ']');
  assert.match(block, /expand_result/, 'expand_result 读出的正是模型看到的内容，不纳入就会「证据与所见对不上」');
});

test('读类工具要单独留存**全文**（截断之前的原始结果）', () => {
  const loop = sliceBetween('const rawResult =', 'ctx.lastEvidence = evidenceAfter');
  assert.match(loop, /const rawResult = typeof res\.result === 'string'/, '必须先取原始结果');
  assert.match(src, /ctx\.lastReadFullText = rawResult/, '读类工具要留存全文供按事实定位片段');
});

test('留存全文必须发生在截断之前', () => {
  // res.result 会被大结果截断改写；若在截断之后再取，留存的还是开头 3000 字，等于没改
  const rawAt = indexOfLine('const rawResult =');
  const truncateAt = indexOfLine('res.result = res.result.slice(0, 3000)');
  assert.ok(rawAt < truncateAt, 'rawResult 必须在截断之前取');
});

test('完成校验改用按事实定位片段，而不是固定窗口', () => {
  const fn = sliceBetween('export function buildVerificationEvidence', '// 用最近页面证据做一次独立校验');
  assert.match(fn, /selectEvidence\(/, '必须走 selectEvidence');
  assert.match(fn, /fullText: ctx\.lastReadFullText/, '要把全文交给证据选择');
  assert.ok(!/lastEvidence\)\.slice\(0, 2500\)/.test(fn), '不应再退回到固定窗口截断');
  assert.match(fn, /coverage/, '覆盖率标注必须一并给出（否则校验方会高估证据完整度）');
});

test('证据必须**同时**含动作回执与页面片段（曾经只用后者，回执被挤掉）', () => {
  const fn = sliceBetween('export function buildVerificationEvidence', '// 用最近页面证据做一次独立校验');
  assert.match(fn, /ctx\.lastEvidence/, '动作回执必须进证据 —— 它回答「刚刚做了什么」');
  assert.match(fn, /selectEvidence\(/, '页面片段也必须进证据 —— 它回答「结论与页面是否一致」');
  assert.match(fn, /最近一次动作的回执/, '两份证据要标注来源，否则校验方分不清哪句是页面原文');
});

test('校验调用的入口走 buildVerificationEvidence', () => {
  const fn = sliceBetween('async function runCompletionVerification', '// 任务结束时清理');
  assert.match(fn, /buildVerificationEvidence\(/, 'runCompletionVerification 应通过它组装证据');
});

test('要告诉校验方本次任务的性质（决定用哪套判据）', () => {
  const fn = sliceBetween('async function runCompletionVerification', '// 任务结束时清理');
  assert.match(fn, /taskKind/, 'verifyCompletion 要收到 taskKind');
  const callSite = sliceBetween('const taskKind =', 'runCompletionVerification(');
  assert.match(callSite, /readOnlyRun \? 'read' : 'mutation'/, '任务性质应由「是否跑过写类工具」推出');
});
