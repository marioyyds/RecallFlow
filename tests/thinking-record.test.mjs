// 思考记录（思维链）的接线门禁。
//
// 为什么需要它：这一层全是**跨文件约定**，任何一环断了都不会报错，只会静默不显示 ——
//   ① agent.js 要把 reasoning_content 发成独立事件（不能混进正文）；
//   ② 面板要认这个事件类型（写错字符串 → 事件被忽略，用户以为模型没思考）；
//   ③ CSS 要真的进 bundle（写在别的文件里 = 编译后不存在）；
//   ④ **思维链绝不能进 conversation** —— 那会把它写回请求：
//      既改写请求前缀（缓存全失效），又会因为该字段不可回传而被 API 拒绝。
//
// 这类"看着都对、其实没接上"的问题在本仓库出现过多次（见 change-delivery-summary 第七节），
// 所以这里逐条钉住。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const chatSrc = fs.readFileSync('lib/page/chat.js', 'utf8');
const agentSrc = fs.readFileSync('lib/assistant/agent.js', 'utf8');
const cssSrc = fs.readFileSync('lib/page/panel-css.js', 'utf8');
const bundle = fs.readFileSync('content.js', 'utf8');

// ---------------------------------------------------------------- 后台侧

test('agent.js：把 reasoning_content 发成独立事件，而不是混进 chunk', () => {
  assert.match(agentSrc, /delta\.reasoning_content/, '应读取 delta.reasoning_content');
  assert.match(
    agentSrc,
    /type:\s*'reasoning'/,
    '必须发 type:reasoning 事件 —— 混进 chunk 后，面板就再也分不出哪段是思考、哪段是回答'
  );
  // 思维链不能混进正文累积
  const reasoningBlock = agentSrc.slice(agentSrc.indexOf('delta.reasoning_content') - 200);
  assert.ok(
    !/contentAcc\s*\+=\s*delta\.reasoning_content/.test(agentSrc),
    '思维链不得累加进 contentAcc（那会让它变成正文的一部分）'
  );
  assert.ok(reasoningBlock.includes('reasoningAcc'), '应累积到独立的 reasoningAcc');
});

test('agent.js：思维链算作首个增量（否则思考耗时会被错算进 prefill）', () => {
  const firstTokenLine = agentSrc
    .split('\n')
    .find((l) => l.includes('firstTokenAt = Date.now()'));
  assert.ok(firstTokenLine, '应能找到首个增量的判定行');
  // 判定条件里必须包含 reasoning_content
  const condLine = agentSrc.split('\n').find((l) => l.includes('if (!firstTokenAt &&'));
  assert.ok(condLine, '应能找到判定条件');
  assert.match(condLine, /delta\.reasoning_content/, '判定条件应包含 reasoning_content：' + condLine);
});

test('agent.js：assistantMessage **不带**思维链（写回会破坏前缀缓存）', () => {
  // assistantMessage 会被 push 进历史并在下一轮原样发回，因此它只能有 role/content/tool_calls。
  const region = agentSrc.slice(agentSrc.indexOf('const assistantMessage ='));
  const head = region.slice(0, region.indexOf('cleanup()'));
  assert.ok(!/reasoning/.test(head), 'assistantMessage 的构造里不得出现 reasoning：\n' + head);
});

// ---------------------------------------------------------------- 面板侧

test('chat.js：受理 reasoning 事件并写进思考记录块', () => {
  assert.match(chatSrc, /resp\.type === 'reasoning'/, '端口消息处理里必须认这个事件类型');
  assert.match(chatSrc, /function pushReasoning\(/, '应有 pushReasoning');
  assert.match(chatSrc, /pushReasoning\(resp\.text\)/, '应把事件文本交给 pushReasoning');
});

test('chat.js：正文/结束/进入工具步骤时都要给思考记录定稿', () => {
  // 少任何一处，思考记录都会一直转（data-state 停在 running，动画不停）。
  const finishCalls = chatSrc.match(/finishReasoning\(\)/g) || [];
  assert.ok(finishCalls.length >= 3, 'finishReasoning 至少在 chunk / end / appendStep 三处被调用，实际 ' + finishCalls.length + ' 处');
  for (const marker of ["resp.type === 'chunk'", "resp.type === 'end'", 'function appendStep(']) {
    const at = chatSrc.indexOf(marker);
    assert.ok(at >= 0, '找不到 ' + marker);
    const nearby = chatSrc.slice(at, at + 700);
    assert.match(nearby, /finishReasoning\(\)/, marker + ' 分支里应调用 finishReasoning');
  }
});

test('chat.js：思考记录的展开状态是**三态**，不是布尔', () => {
  // 与计划条同一个坑：若写成「布尔 + 初值」，「用户手动收起」会永远被下一次自动展开覆盖。
  assert.match(chatSrc, /let thinkExpandedManual = null;/, '初值必须是 null（未表态）');
  assert.match(chatSrc, /thinkExpandedManual === null/, '自动开合必须先判断用户是否表过态');
  // 用户一旦点过，就不再自动改
  assert.match(chatSrc, /thinkExpandedManual = opening;/, '点击时应记录用户的选择');
});

test('chat.js：新一轮开始时清掉上一轮的思考记录指针', () => {
  assert.match(chatSrc, /function resetReasoning\(/, '应有 resetReasoning');
  assert.match(chatSrc, /resetReasoning\(\);/, 'run() 里应调用它');
});

test('chat.js：面板重开时思维链要恢复（否则记录凭空消失）', () => {
  const at = chatSrc.indexOf('function restoreStreamingUI');
  assert.ok(at >= 0);
  const body = chatSrc.slice(at, at + 4000);
  assert.match(body, /pendingReasoning/, '恢复路径应使用已累积的思维链');
  assert.match(body, /ensureThinkBlock\(\)/, '恢复路径应重建思考记录块');
});

test('chat.js：思维链**只用于展示** —— 绝不进入 conversation（不会写回请求）', () => {
  // conversation 是发给后台的历史来源；思维链一旦进去就会被拼进请求。
  const pushes = chatSrc.match(/conversation\.push\([^)]*\)/g) || [];
  for (const p of pushes) {
    assert.ok(!/reason/i.test(p), 'conversation.push 不得推入思维链：' + p);
  }
  assert.ok(
    !/conversation\.push\(\s*\{[^}]*reasoning/.test(chatSrc),
    'conversation 里不得出现 reasoning 字段'
  );
});

// ---------------------------------------------------------------- 样式

test('CSS：思考记录的样式真的随 PANEL_CSS 一起走', () => {
  assert.match(cssSrc, /\.think-block\s*\{/, '缺少 .think-block 样式');
  assert.match(cssSrc, /\.think-head\s*\{/, '缺少 .think-head 样式');
  assert.match(cssSrc, /\.think-body\s*\{/, '缺少 .think-body 样式');
  assert.match(cssSrc, /\.think-block\[data-open="true"\] \.think-body\s*\{\s*display:\s*block/, '展开态应显示正文');
});

test('CSS：进行中的动画只在 data-state="running" 时跑', () => {
  // 静止的思考记录若继续闪，用户会误以为还在生成。
  assert.match(
    cssSrc,
    /\.think-block\[data-state="running"\] \.think-dots span\s*\{[^}]*animation:/,
    '动画必须挂在 [data-state="running"] 上'
  );
  const base = cssSrc.match(/\.think-dots span\s*\{([^}]*)\}/);
  assert.ok(base, '应有 .think-dots span 基础样式');
  assert.ok(!/animation:/.test(base[1]), '基础样式里不得有无条件动画：' + base[1]);
});

test('CSS：扫光动画必须用 @supports 包住（否则文字可能整个变没）', () => {
  // background-clip:text 不生效时，-webkit-text-fill-color:transparent 会让标签文字不可见。
  const fillAt = cssSrc.indexOf('-webkit-text-fill-color: transparent');
  assert.ok(fillAt > 0, '应有扫光效果');
  const before = cssSrc.slice(Math.max(0, fillAt - 700), fillAt);
  assert.match(before, /@supports/, 'background-clip:text 的写法必须被 @supports 保护');
  assert.match(before, /background-clip: text/, '@supports 条件里应包含 background-clip: text');
});

// ---------------------------------------------------------------- 打包产物

test('content.js 已重新构建，包含思考记录（否则改了源码也不生效）', () => {
  // content.js 是**提交进仓库的产物**，浏览器不执行构建 —— 忘了重建等于这次改动没上线。
  assert.ok(bundle.includes('think-block'), 'content.js 里应能看到 think-block（请跑 node scripts/build-content.mjs）');
  assert.ok(bundle.includes('reasoning'), 'content.js 里应能看到 reasoning 事件处理');
});
