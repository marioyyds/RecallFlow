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

test('chat.js：受理 reasoning 事件并写进思考记录', () => {
  assert.match(chatSrc, /resp\.type === 'reasoning'/, '端口消息处理里必须认这个事件类型');
  assert.match(chatSrc, /function pushReasoning\(/, '应有 pushReasoning');
  assert.match(chatSrc, /pushReasoning\(resp\.text\)/, '应把事件文本交给 pushReasoning');
});

test('chat.js：**每段思考单独一块并追加**（穿插在对话里，不是聚成一个总块）', () => {
  // 用户明确要求：思考不要单独一个滚动区/总块，而应穿插在对话流中。
  // 实现要点有两处，缺一不可：
  //   ① 挂载时 appendChild 到末尾（不是 insertBefore 到最前）；
  //   ② 定稿后把「进行中的段」指针置 null，下一段才会另起一块。
  assert.ok(!/insertBefore\(block/.test(chatSrc), '不得把思考块插到对话最前面');
  const mount = chatSrc.slice(chatSrc.indexOf('function mountThinkSegment('));
  const mountBody = mount.slice(0, mount.indexOf('\n}'));
  assert.match(mountBody, /flowEl\.appendChild\(block\)/, '应追加到 flow 末尾（穿插）');
  const finish = chatSrc.slice(chatSrc.indexOf('function finishReasoning('));
  const finishBody = finish.slice(0, finish.indexOf('\n  }'));
  assert.match(finishBody, /thinkSeg = null;/, '定稿后必须断掉进行中的段指针 —— 否则下一段会写回同一块');
});

test('chat.js：定稿的思考记录进 pendingParts（面板重建时按原位置还原）', () => {
  const finish = chatSrc.slice(chatSrc.indexOf('function finishReasoning('));
  const finishBody = finish.slice(0, finish.indexOf('\n  }'));
  assert.match(finishBody, /pendingParts\.push\(\{\s*type:\s*'thinking'/, '定稿时应记入 flow 记录');
  // 恢复路径要认得这个类型，否则重开面板后思考全挤到最前（或直接消失）
  const restore = chatSrc.slice(chatSrc.indexOf('function restoreStreamingUI('));
  const restoreBody = restore.slice(0, 3600);
  assert.match(restoreBody, /p\.type === 'thinking'/, '重建循环应处理 thinking 部件');
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

test('chat.js：思考块**默认折叠** —— 进行中也是折叠的', () => {
  // 用户要求：「思考中时应该折叠比较好，用户自己根据其需要展开」。
  // 旧实现是反的：进行中自动展开（`seg.done ? 'false' : 'true'`），正文开始时才收起。
  //
  // ⚠ 口径升级（修复"重开面板后思考记录整块消失"之后）：标记现在只有**一处来源** ——
  //   `thinkBlockHtml()`，实时挂载与历史重建都从它出。因此"初值由显式传入的 open 决定"
  //   这条规则钉在 **builder** 里，mount 那条路只负责把 open 原样传进去。
  const builder = chatSrc.slice(chatSrc.indexOf('function thinkBlockHtml('));
  const builderBody = builder.slice(0, builder.indexOf('\n}'));
  assert.ok(builderBody.length > 0, '应有 thinkBlockHtml（标记的唯一来源）');
  assert.match(builderBody, /data-open=/, 'data-open 必须在 builder 里产出');
  assert.match(builderBody, /o\.open === true \? 'true' : 'false'/, '初值只能由显式 open 决定（不传 = 折叠）');
  assert.ok(!/data-open="[^\n]*o\.done/.test(builderBody), '不得按"定稿了才折叠"来决定初值');

  const mount = chatSrc.slice(chatSrc.indexOf('function mountThinkSegment('));
  const mountBody = mount.slice(0, mount.indexOf('\n}'));
  assert.match(mountBody, /thinkBlockHtml\(seg\.text, \{ open: open,/, 'mount 必须把显式 open 传进 builder');
  // 新段（pushReasoning）与历史段（pendingParts 重建）都不传展开态 ⇒ 折叠
  const push = chatSrc.slice(chatSrc.indexOf('function pushReasoning('));
  const pushBody = push.slice(0, push.indexOf('\n  }'));
  assert.match(pushBody, /mountThinkSegment\(thinkSeg\);/, '新段必须以折叠挂载（不传展开态）');
});

test('chat.js：思考块标记**只有一处来源**（两条路共用，重复一份必然漂移）', () => {
  // 修复"重开面板后思考整块消失"时立下的规矩：标记只写一遍。
  // 重复一份的后果不是报错，而是两条路各自演进 —— 而这次的缺陷正是
  // "一条路有标记、另一条路压根没有这个分支"。
  const markup = chatSrc.match(/class="think-block"/g) || [];
  assert.equal(markup.length, 1, '思考块标记只能出现一次，实际 ' + markup.length + ' 处');
  const mount = chatSrc.slice(chatSrc.indexOf('function mountThinkSegment('));
  assert.match(mount.slice(0, 900), /createContextualFragment\(\s*thinkBlockHtml\(/, '流式挂载必须用 thinkBlockHtml 解析出节点');
  const restore = chatSrc.slice(chatSrc.indexOf('function renderConversation('));
  assert.match(restore.slice(0, 6000), /return thinkBlockHtml\(/, '历史重建必须用 thinkBlockHtml');
});

test('chat.js：重开面板时必须重建思考记录（renderConversation 要有 thinking 分支）', () => {
  // 用户实测反馈：「关闭 recallflow 对话，再打开，思考历史消失了」。
  // 根因**不在存储**：`parts`（含 thinking）一直随对话存进 chrome.storage.session。
  // 少的是**重建分支** —— renderConversation 只认 narration / text / tool-* / screenshot，
  // 思考块整块掉进 `return ''`。为什么以往 E2E 没抓到：它们只验过"流式进行中重开"
  //（那条路 restoreStreamingUI 早就有 thinking 分支），从没在**一轮结束之后**关过面板。
  const at = chatSrc.indexOf('function renderConversation(');
  assert.ok(at >= 0);
  const body = chatSrc.slice(at, at + 6000);
  assert.match(body, /p\.type === 'thinking'/, '重建循环必须处理 thinking 部件');
  assert.match(
    body,
    /thinkBlockHtml\(p\.text, \{ done: true/,
    '历史段必须按**定稿**态重建 —— 静止的历史不该继续跑"思考中"的动画'
  );
});

test('chat.js：重建出来的思考块也要能点开（开合必须是委托的）', () => {
  // 重建的块是 innerHTML 生成的，**没有**自己的监听器 ⇒ 开合必须委托在 panelBody 上；
  // 否则重开后思考块点了没反应（比"看不到"更隐蔽：块在，但打不开）。
  assert.match(chatSrc, /e\.target\.closest\('\.think-head'\)/, 'panelBody 的 click 处理里必须认 .think-head');
  const mount = chatSrc.slice(chatSrc.indexOf('function mountThinkSegment('));
  const mountBody = mount.slice(0, mount.indexOf('\n}'));
  assert.ok(
    !/addEventListener\('click'/.test(mountBody),
    'mountThinkSegment 不得再自己挂 click —— 与委托叠加会让一次点击切换两次'
  );
});

test('chat.js：被持久化截断的思考必须标明（丢东西要说明）', () => {
  // clipPart 会按 MAX_PART_TEXT_CHARS 裁掉超长思维链。若重建后当成完整全文展示，
  // 用户会以为模型只想到这儿 —— 那正是本仓库最忌的"静默丢失"。
  assert.match(chatSrc, /function thinkLabelText\(done, len, truncated\)/, '文案要有唯一来源');
  assert.match(chatSrc, /保存时已截断/, '截断必须有一句可读的标注');
  const restore = chatSrc.slice(chatSrc.indexOf('function renderConversation('));
  assert.match(restore.slice(0, 6000), /truncated: p\.textTruncated === true/, '重建时要把 parts 上的截断标记传进去');
});

test('chat.js：流式增量**不碰**用户的展开状态，也不重置滚动位置', () => {
  // 用户选择优先是**结构性**保证的：思考增量路径一个字都不写 data-open / scrollTop，
  // 所以新事件到达时在结构上不可能把用户手动展开/折叠改回去，也不会把滚动位置重置。
  //
  // ⚠ 只看**活代码**（先剥掉注释行）：否则"这里故意不写 dataset.open"这类**说明性注释**
  // 会把这条门禁自己判红 —— 那正是本仓库踩过的"门禁把解释当成违规"的形态
  //（`skill-content-structure.test.mjs` 的标记原文就是这么把自己判红的）。
  const live = chatSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const at = live.indexOf("resp.type === 'reasoning'");
  assert.ok(at >= 0, '应能找到 reasoning 分支');
  const branch = live.slice(at, live.indexOf("resp.type === 'chunk'"));
  // ⚠ 口径升级（用户反馈"模型思考时没有流式置底"之后）：这条**不是**"思考路径一个字都不许碰滚动"，
  //   而是"**不许无条件重置滚动位置**" —— 与正文/工具路径一致的**受守卫**写法
  //   （`if (observerAutoScroll && panelBody) panelBody.scrollTop = …`，即"只有用户没自己滚上去时才置底"）
  //   本来就是"用户选择优先"的实现 ✓；真正违规的是**不带守卫**的 `scrollTop =` ✗。
  //   原先按"出现 scrollTop 即违规"判 ⇒ 把受守卫的置底也禁掉了，思考期间视图就不跟手了。
  const unguardedScroll = (src) =>
    src.split('\n').filter((l) => /scrollTop\s*=/.test(l) && !/observerAutoScroll/.test(l));
  assert.deepEqual(unguardedScroll(branch), [], '思考增量分支不得**无条件**设置 scrollTop（会重置用户的滚动位置）');
  assert.ok(!/dataset\.open/.test(branch), '思考增量分支不得写 data-open（会覆盖用户的选择）');

  const push = live.slice(live.indexOf('function pushReasoning('));
  const pushBody = push.slice(0, push.indexOf('\n  }'));
  assert.ok(!/dataset\.open/.test(pushBody), 'pushReasoning 不得写 data-open（增量不许改用户的选择）');
  assert.deepEqual(unguardedScroll(pushBody), [], 'pushReasoning 不得**无条件**设置 scrollTop');
  // 反向样张：这些写法必须被抓住（否则上面的断言是恒真的）
  assert.ok(/dataset\.open/.test('    seg.block.dataset.open = "true";'), '反向样张：写 data-open 应被认出');
  assert.equal(
    unguardedScroll('    panelBody.scrollTop = panelBody.scrollHeight;').length,
    1,
    '反向样张：**无条件**置底必须被认出（否则守卫形同虚设）'
  );
  assert.equal(
    unguardedScroll('    if (observerAutoScroll && panelBody) panelBody.scrollTop = panelBody.scrollHeight;').length,
    0,
    '受守卫的置底必须被允许（那正是"用户选择优先"）'
  );
});

test('chat.js：新一轮开始时清掉上一轮的思考记录指针', () => {
  assert.match(chatSrc, /function resetReasoning\(/, '应有 resetReasoning');
  assert.match(chatSrc, /resetReasoning\(\);/, 'run() 里应调用它');
});

test('chat.js：面板重开时思维链要恢复（否则记录凭空消失）', () => {
  const at = chatSrc.indexOf('function restoreStreamingUI');
  assert.ok(at >= 0);
  const body = chatSrc.slice(at, at + 3600);
  assert.match(body, /thinkSeg/, '恢复路径应处理"进行中的那一段"');
  assert.match(body, /mountThinkSegment\(/, '恢复路径应重建思考记录块');
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

test('CSS：思考记录**不得**有内层滚动条（否则与面板滚动打架）', () => {
  // 用户明确要求：思考不是单独一个滚动区。内层滚动会让滚轮停在里面、外层滚不动，
  // 而且思考与它前后的步骤不在同一个滚动坐标里，看不出对应关系。
  const body = cssSrc.match(/\.think-body\s*\{([^}]*)\}/);
  assert.ok(body, '应有 .think-body 样式');
  assert.ok(!/max-height/.test(body[1]), '.think-body 不得设 max-height（会造出内层滚动区）：' + body[1]);
  assert.ok(!/overflow(-y)?\s*:\s*(auto|scroll)/.test(body[1]), '.think-body 不得设内层滚动：' + body[1]);
});

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
