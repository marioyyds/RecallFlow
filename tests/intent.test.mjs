import test from 'node:test';
import assert from 'node:assert/strict';
import { detectIntent, extractKeyword, INTENTS, buildSystemPrompt } from '../lib/assistant/intent-router.ts';

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
