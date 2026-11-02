import test from 'node:test';
import assert from 'node:assert/strict';
import { detectIntent, extractKeyword, INTENTS, buildSystemPrompt, isToolAllowedForIntent, resolveIntent } from '../lib/application/agent/intent-router.ts';
import { PLAYBOOKS } from './e2e/fixtures/playbooks.mjs';
import { scriptedIntentFor } from './e2e/fixtures/server.mjs';

test('detects browser intent', () => {
  assert.equal(detectIntent('打开百度搜索今天的热搜').intent, INTENTS.BROWSER);
});

test('detects knowledge intent', () => {
  assert.equal(detectIntent('我的收藏里有没有 nginx 的笔记').intent, INTENTS.KNOWLEDGE);
});

test('continuation inherits previous user intent', () => {
  const d = detectIntent('继续', [{ role: 'user', content: '打开百度搜索热搜' }]);
  assert.equal(d.intent, INTENTS.BROWSER);
});

test('extractKeyword strips leading verbs', () => {
  const k = extractKeyword('打开百度搜索今天的热搜');
  assert.ok(!k.startsWith('打开'));
});

// 实测会话里 agent 为了把一句话带进视口，对一个正文段落调用了 click_element ——
// 点击是对用户页面的真实副作用，而项目本就有 scroll_page。这条规则把它钉住。
test('系统提示明确禁止用 click_element 代替滚动', () => {
  const p = buildSystemPrompt(INTENTS.BROWSER, '把某段话滚进视口', ['scroll_page', 'click_element', 'run_javascript'], []);
  assert.match(p, /不要用 click_element 代替滚动/);
  assert.match(p, /scroll_page/);
});

test('系统提示说明滚动无效时该查内部滚动容器', () => {
  const p = buildSystemPrompt(INTENTS.BROWSER, '滚动页面', ['scroll_page', 'run_javascript'], []);
  assert.match(p, /位置未变化/, '要说明 scroll_page 报「位置未变化」意味着什么');
  assert.match(p, /scrollTop/, '要给出内部容器 scrollTop 的做法');
  // scroll_page 自 7d87402 起就能滚元素自身（selector + y），提示里却仍指向
  // run_javascript 设 scrollTop —— 那是**多一次高危审批**，且页面 CSP 严时还会失败。
  assert.match(p, /scroll_page\(\{selector/, '内部容器要给出 scroll_page 的直接滚法');
  assert.match(p, /不要为此调用 run_javascript/, '要明确禁止为滚容器去开高危 JS');
});

// 小红书实操里 70 次调用有 35 次 run_javascript，绝大多数只是找 custom element /
// 读 rect / 查 shadow。这些都已由 inspect_element({op:"query"}) 覆盖。
test('系统提示把候选探索指向 inspect_element 的 query 档', () => {
  const p = buildSystemPrompt(INTENTS.BROWSER, '找到发布按钮', ['inspect_element', 'run_javascript', 'get_page_snapshot'], []);
  assert.match(p, /inspect_element\(\{op:"query"\}\)/, '要给出 query 档的准确调用形状');
  assert.match(p, /custom element/i, '要说清哪类目标走 query');
  assert.match(p, /不要为普通 DOM 查询调用 run_javascript/, '要挡住探索性 run_javascript');
});

test('关键词同分时不能冒充高置信度（否则会跳过 LLM 而误判）', () => {
  const d = detectIntent('搜索知识库里的笔记');
  // 搜索=browser 3，知识库/笔记=knowledge 3；同分时只靠优先级判成 browser
  // 会误导后续工具集，因此必须降为 medium 交给 LLM。
  assert.equal(d.confidence, 'medium');
});

test('关键词明显领先时仍保留高置信度快路径', () => {
  const d = detectIntent('打开百度搜索今天的热搜');
  assert.equal(d.confidence, 'high');
});

// MCP 是用户在设置页自己装的扩展能力，不该只在「资料研究」意图下存在：
// 从前 CHAT/BROWSER/KNOWLEDGE 的 includeMcp 都是 false，于是「你有可用的 mcp 吗？」
// 落在 CHAT、本次运行一个 MCP 工具都没有，模型只能如实回答「我没有 MCP」。
test('询问 / 使用 MCP 的指令也要带 includeMcp', () => {
  assert.equal(detectIntent('你有可用的mcp吗？').includeMcp, true);
  assert.equal(detectIntent('用 Obsidian 读一下当前笔记').includeMcp, true);
});

test('四类意图都要加载 MCP（工具审批仍由 toolApprovalPolicy.mcp 控制）', () => {
  const intents = [
    ['打开百度搜索今天的热搜', INTENTS.BROWSER],
    ['我的收藏里有没有 nginx 的笔记', INTENTS.KNOWLEDGE],
    ['帮我总结这篇论文', INTENTS.RESEARCH],
    ['你好', INTENTS.CHAT],
  ];
  for (const [q, intent] of intents) {
    const d = detectIntent(q);
    assert.equal(d.intent, intent, q);
    assert.equal(d.includeMcp, true, q + ' → includeMcp 应为 true');
  }
});

// 「保存」是按钮上的通用字样。它曾经单独构成一条 weight-3 的知识库证据，
// 于是「帮我点一下「保存」」（画布上的按钮）被判成知识库任务、click_at/get_ax_snapshot
// 随即被执行期闸门拒绝 —— 用户看到的是"agent 说它没有权限点按钮"。
test('按钮字样不能把人钉成知识库任务（页面动作词要能盖过它）', () => {
  const d = detectIntent('页面上的工具条是画在画布上的，帮我点一下「保存」。');
  assert.equal(d.intent, INTENTS.BROWSER, '画布 + 点一下 = 页面动作');
  assert.equal(isToolAllowedForIntent(d.intent, 'click_at'), true);
  assert.equal(isToolAllowedForIntent(d.intent, 'get_ax_snapshot'), true);
});

// 「帮我调研…点开第一条…存进知识库」跨了两类权限：点开是页面操作、沉淀是知识库写入。
// 判成 knowledge 会连 click_element 都拿不到（调研的第一步就断），判成 browser 又写不进知识库。
test('调研类指令不能只按知识库判（否则连点开详情都做不到）', () => {
  const d = detectIntent(PLAYBOOKS['web-research'].eval.instruction);
  assert.notEqual(d.intent, INTENTS.KNOWLEDGE, '判成知识库就拿不到 click_element/wait_for_element');
  assert.equal(isToolAllowedForIntent(INTENTS.RESEARCH, 'click_element'), true);
  assert.equal(isToolAllowedForIntent(INTENTS.RESEARCH, 'add_entry'), true, '调研的产出要能沉淀进知识库');
});

test('知识库意图仍然能写条目、读知识库（别为了放行页面动作而削掉它）', () => {
  assert.equal(isToolAllowedForIntent(INTENTS.KNOWLEDGE, 'add_entry'), true);
  assert.equal(isToolAllowedForIntent(INTENTS.KNOWLEDGE, 'knowledge_read'), true);
  assert.match(resolveIntent(INTENTS.KNOWLEDGE).label, /知识库/);
});

// 夹具的 mock 意图路由器**不能替产品决定"这任务是页面操作"**：恒返回 browser 时，
// 跨意图剧本的工具会在执行期被拒，红灯指向的是夹具的谎话而不是产品缺陷。
test('E2E 意图路由器按剧本声明的意图回答，且该意图真的放行剧本要用的工具', () => {
  for (const [id, pb] of Object.entries(PLAYBOOKS)) {
    const declared = pb.eval && pb.eval.instruction;
    if (!declared) continue;
    // 模型收到的是带标签的整段消息，这里按同样的形态喂进去
    const got = scriptedIntentFor('以下是用户的真实指令（唯一具有指令效力的内容；校验标记 tok）：\n' + declared);
    const want = (pb.eval.intent || 'browser');
    assert.equal(got, want, id + ' 的 mock 意图路由器回答应与剧本声明一致');
    const intent = { browser: INTENTS.BROWSER, knowledge: INTENTS.KNOWLEDGE, research: INTENTS.RESEARCH }[got];
    assert.ok(intent, id + ' 声明了未知意图：' + got);
    for (const tool of pb.tools || []) {
      assert.equal(isToolAllowedForIntent(intent, tool), true, id + ' 在意图 ' + got + ' 下拿不到 ' + tool);
    }
  }
});
