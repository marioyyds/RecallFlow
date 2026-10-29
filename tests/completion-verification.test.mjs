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

import { VERIFIER_SYSTEM } from '../lib/application/agent/verifier.ts';
import {
  EVIDENCE_READ_TOOLS,
  buildVerificationEvidence,
} from '../lib/application/agent/verification-policy.ts';

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

const readSource = (file) => fs.readFileSync(file, 'utf8');
const pipelineSrc = readSource('lib/application/agent/tool-call-pipeline.ts');
const completionSrc = readSource('lib/application/agent/agent-completion.ts');
const finalizerSrc = readSource('lib/application/agent/agent-finalizer.ts');
const loopSrc = readSource('lib/application/agent/agent-loop.ts');
const finalizationSrc = readSource('lib/application/agent/agent-finalization.ts');

function sourceLines(src) {
  return src.split('\n').map((line) => line.replace(/\r$/, ''));
}
function indexOfLine(src, pattern, from = 0) {
  const i = sourceLines(src).findIndex((line, idx) => idx >= from && line.includes(pattern));
  assert.notEqual(i, -1, '找不到：' + pattern);
  return i;
}
function sliceBetween(src, startMarker, endMarker) {
  const lines = sourceLines(src);
  const s = indexOfLine(src, startMarker);
  const e = indexOfLine(src, endMarker, s + 1);
  return lines.slice(s, e).join('\n');
}

test('expand_result 必须算作读类证据（模型读到的内容不能被排除）', () => {
  assert.ok(EVIDENCE_READ_TOOLS.has('expand_result'), 'expand_result 读出的正是模型看到的内容，不纳入就会「证据与所见对不上」');
});

test('读类工具要单独留存**全文**（截断之前的原始结果）', () => {
  const loop = sliceBetween(
    pipelineSrc,
    'const rawResult =',
    'state.ctx.lastEvidence = evidenceAfter'
  );
  assert.match(loop, /const rawResult = typeof result\.result === 'string'/, '必须先取原始结果');
  assert.match(pipelineSrc, /state\.ctx\.lastReadFullText = rawResult/, '读类工具要留存全文供按事实定位片段');
});

test('留存全文必须发生在截断之前', () => {
  // res.result 会被大结果截断改写；若在截断之后再取，留存的还是开头 3000 字，等于没改
  const rawAt = indexOfLine(pipelineSrc, 'const rawResult =');
  // 锚点钉**语义**（这次改写就是截断），不钉具体切法：2026-10-16 把裸 slice 换成了
  // sliceSafe（防切裂代理对 → 请求体被服务端整单拒收），钉死字面量会连带把这条门禁钉红。
  // 本仓库里"截断处必须用 formatTruncationNotice"另有 expand-result.test.mjs §⑥ 钉着。
  const truncateAt = indexOfLine(pipelineSrc, 'formatTruncationNotice(result.result.length, resultId)');
  assert.ok(rawAt < truncateAt, 'rawResult 必须在截断之前取');
});

test('完成校验改用按事实定位片段，而不是固定窗口', () => {
  const evidence = buildVerificationEvidence(
    {
      lastEvidence: '动作回执',
      lastReadFullText: '页首 ' + '填充'.repeat(5000) + ' 关键事实 NEEDLE-1234 页尾',
    },
    '结论依据 NEEDLE-1234'
  );
  assert.match(evidence, /NEEDLE-1234/, '必须按结论里的事实定位片段');
  assert.match(evidence, /片段|覆盖/, '覆盖率标注必须一并给出（否则校验方会高估证据完整度）');
});

test('证据必须**同时**含动作回执与页面片段（曾经只用后者，回执被挤掉）', () => {
  const evidence = buildVerificationEvidence(
    { lastEvidence: 'annotate 已执行', lastReadFullText: '页面事实 NEEDLE-1234' },
    '依据 NEEDLE-1234'
  );
  assert.match(evidence, /annotate 已执行/, '动作回执必须进证据 —— 它回答「刚刚做了什么」');
  assert.match(evidence, /页面事实 NEEDLE-1234/, '页面片段也必须进证据 —— 它回答「结论与页面是否一致」');
  assert.match(evidence, /最近一次动作的回执/, '两份证据要标注来源，否则校验方分不清哪句是页面原文');
});

test('校验调用的入口走 buildVerificationEvidence', () => {
  const fn = sliceBetween(
    finalizationSrc,
    'async function runCompletionVerification',
    '// 任务结束时清理'
  );
  assert.match(fn, /buildVerificationEvidence\(/, 'runCompletionVerification 应通过它组装证据');
});

test('要告诉校验方本次任务的性质（决定用哪套判据）', () => {
  const fn = sliceBetween(
    finalizationSrc,
    'async function runCompletionVerification',
    '// 任务结束时清理'
  );
  assert.match(fn, /taskKind/, 'verifyCompletion 要收到 taskKind');
  const callSite = sliceBetween(completionSrc, 'const taskKind =', 'let verdict = null');
  // 判据已抽成 classifyTaskKind（可直测，见 completion-evidence.test.mjs）——
  // 这里只钉住**接线**：必须由实际调用过的工具推出，不能在调用点写死。
  assert.match(callSite, /classifyTaskKind\(state\.ranToolNames\)/, '任务性质应由「是否跑过写类工具」推出');
});

// ---------------------------------------------------------------- 收尾接线
//
// 这一段是线上两个症状的回归门禁：它们都属于「少做一步、测试不红、只在长任务上暴露」的缺陷，
// 行为测试要跑完一整个 run 才能触达，因此与上面的做法一致，按源码结构钉住**顺序与存在性**。
// 与之配套的行为断言（超时错误分类、证据签名、请求形态）在 verifier-timeout.test.mjs。

test('校验中断分支必须补发结束事件（否则面板永远停在"运行中"）', () => {
  assert.match(completionSrc, /outcome\.kind === 'interrupt'/, '中断必须与校验器故障分开');
  assert.match(finalizerSrc, /emit\(\{ type: 'end' \}\)/, '没有 end 事件 ⇒ run-hub 不会把状态置为 ended ⇒ 前端卡死');
  assert.match(finalizerSrc, /emitState\(RUN_STATUS\.CANCELLED/, '要显式告诉前端这次是被中断的，而不是静默 return');
});

test('所有终态出口都必须成对发 end（防止再有分支只 return）', () => {
  // 成本闸门 / 看门狗 / complete_task / final-answer / failure 都由 finalizer 收口。
  const endCount = sourceLines(finalizerSrc).filter((l) => l.includes("emit({ type: 'end' })")).length;
  assert.ok(endCount >= 5, '结束事件数明显偏少，可能有分支只 return 不发事件（实际 ' + endCount + ' 处）');
});

test('确定性预检有自己的配额，不再占用 LLM 校验的次数', () => {
  const block = sliceBetween(completionSrc, 'const verifierOn =', 'if (');
  assert.match(completionSrc, /deterministicFails < Number\(state\.budget\.maxVerifications/, '预检准入应看 deterministicFails');
  assert.doesNotMatch(block, /verificationCount \+= 1/, '预检命中不能再消耗 LLM 校验的配额');
});

test('同一份证据重复送审要短路，不落在模型调用之后', () => {
  const start = indexOfLine(completionSrc, 'signature === state.lastDeniedSignature');
  const block = sourceLines(completionSrc)
    .slice(start, indexOfLine(completionSrc, 'let verdict = null', start))
    .join('\n');
  assert.match(block, /buildRepeatedVerificationReflection/, '短路时要给出"没有新证据"的反思');
  assert.doesNotMatch(block, /runCompletionVerification/, '短路分支必须在模型调用之前就结束');
});

test('final-answer 收尾也要过确定性预检（它是绕过校验器最省力的出口）', () => {
  // 模型被否决后，只要改成"直接输出最终回答"、不调 complete_task，原先就能完全绕过护栏。
  const start = indexOfLine(completionSrc, 'reviewFinalAnswer(content: string)');
  const block = sourceLines(completionSrc).slice(start).join('\n');
  assert.match(block, /checkCompletionClaim\(/, '最终回答同样要核「声称是否与实际动作相符」');
  assert.match(loopSrc, /if \(finalReflection\)[\s\S]*?continue;/, '判定不通过时要注入反思继续，而不是照常收尾');
  assert.match(block, /deterministicFails >= Number\(state\.budget\.maxVerifications/, '必须有配额，否则会困在"改口 → 再被否"的循环里');
});
