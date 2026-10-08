// Agent 核心回归测试：
//  - promoteToResearch：画像提升必须保留追加的系统提示段（曾静默丢弃站点记忆 / 宏目录）
//  - toolNeedsApproval：risk → 审批类别的显式映射（曾依赖默认值兜底）
import test from 'node:test';
import assert from 'node:assert/strict';

import { promoteToResearch, toolNeedsApproval, sanitizeToolPairing, compactSessionMessages } from '../lib/assistant/agent.js';

// ---------------------------------------------------------------- 画像提升
//
// 缓存契约：promoteToResearch 必须用「追加 system 消息」的方式应用 RESEARCH 画像，
// 绝不能改写 messages[0]。messages[0] 是整段请求前缀的起点，改写它会让此前累积的
// 全部前缀缓存失效、整段历史重新 prefill。下面每个用例都同时断言这两件事。

const EXTRAS =
  '\n\n【本站点记忆】按钮「提交」→ #submit' +
  '\n\n【本站点已保存的宏】登录流程（3 步）';

const lastMessage = (messages) => messages[messages.length - 1];

test('promoteToResearch: 保留附加段（站点记忆 / 宏目录）', () => {
  const messages = [{ role: 'system', content: '基础系统提示' }];
  promoteToResearch([], messages, '打开页面', [], EXTRAS);
  const content = lastMessage(messages).content;
  assert.ok(content.includes('【本站点记忆】'), content);
  assert.ok(content.includes('【本站点已保存的宏】'), content);
  assert.ok(content.includes('#submit'), content);
});

test('promoteToResearch: 无附加段时不引入 undefined 或多余换行', () => {
  const messages = [{ role: 'system', content: '基础系统提示' }];
  promoteToResearch([], messages, 'x', [], '');
  assert.ok(!lastMessage(messages).content.includes('undefined'), lastMessage(messages).content);
  assert.ok(lastMessage(messages).content.length > 3);
});

test('promoteToResearch: 补齐 RESEARCH 工具，且重复调用不重复添加', () => {
  const messages = [{ role: 'system', content: 's' }];
  const tools = [];
  promoteToResearch(tools, messages, 'x', [], '');
  const names = tools.map((t) => t.function && t.function.name);
  assert.ok(names.includes('fetch_webpage'), names.join(','));
  assert.ok(names.includes('open_tab'), names.join(','));
  const before = tools.length;
  promoteToResearch(tools, messages, 'x', [], '');
  assert.equal(tools.length, before, '已是 RESEARCH 工具集时不应再增长');
});

test('promoteToResearch: 追加 RESEARCH 画像，不改写 messages[0]', () => {
  const original = { role: 'system', content: '旧提示' };
  const messages = [original, { role: 'user', content: '你好' }];
  promoteToResearch([], messages, 'x', [], '');
  assert.equal(messages.length, 3, '应追加一条而不是替换');
  assert.equal(messages[0], original, 'messages[0] 是请求前缀起点，必须原样保留');
  assert.equal(messages[0].content, '旧提示');
  const added = lastMessage(messages);
  assert.equal(added.role, 'system');
  assert.notEqual(added.content, '旧提示', '新画像确实写进了追加的消息');
});

test('promoteToResearch: 首条不是 system 时同样只追加', () => {
  const messages = [{ role: 'user', content: '你好' }];
  promoteToResearch([], messages, 'x', [], '');
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, '你好');
  assert.equal(messages.length, 2);
  assert.equal(lastMessage(messages).role, 'system');
});

// ---------------------------------------------------------------- 审批映射

test('toolNeedsApproval: risk:page 落到 commands 类别', () => {
  assert.equal(toolNeedsApproval('click_element', { toolApprovalPolicy: { commands: true } }), false);
  assert.equal(toolNeedsApproval('click_element', { toolApprovalPolicy: { commands: false } }), true);
  assert.equal(toolNeedsApproval('type_text', { toolApprovalPolicy: { commands: true } }), false);
});

test('toolNeedsApproval: risk:write / destructive 落到 edit 类别', () => {
  assert.equal(toolNeedsApproval('add_entry', { toolApprovalPolicy: { edit: true } }), false);
  assert.equal(toolNeedsApproval('add_entry', { toolApprovalPolicy: { edit: false } }), true);
  assert.equal(toolNeedsApproval('remove_entry', { toolApprovalPolicy: { edit: true } }), false);
});

test('toolNeedsApproval: browser 与 network 共用 browser 类别', () => {
  assert.equal(toolNeedsApproval('open_tab', { toolApprovalPolicy: { browser: true } }), false);
  assert.equal(toolNeedsApproval('fetch_webpage', { toolApprovalPolicy: { browser: true } }), false);
  assert.equal(toolNeedsApproval('open_tab', { toolApprovalPolicy: { browser: false } }), true);
});

test('toolNeedsApproval: external 落到 mcp 类别', () => {
  assert.equal(toolNeedsApproval('install_skill', { toolApprovalPolicy: { mcp: true } }), false);
  assert.equal(toolNeedsApproval('install_skill', { toolApprovalPolicy: { mcp: false } }), true);
});

test('toolNeedsApproval: 只读工具直接放行，不看分类策略', () => {
  // requiresApproval 未置位 → 开头即返回 false，与 read/commands 等策略无关
  assert.equal(toolNeedsApproval('search_knowledge_base', { toolApprovalPolicy: { read: false, commands: false } }), false);
  assert.equal(toolNeedsApproval('web_search', { toolApprovalPolicy: { browser: false } }), false);
  assert.equal(toolNeedsApproval('get_page_snapshot', { toolApprovalPolicy: {} }), false);
});

test('toolNeedsApproval: run_javascript 由 runJavascriptApproval 控制', () => {
  assert.equal(toolNeedsApproval('run_javascript', { runJavascriptApproval: 'auto' }), false);
  assert.equal(toolNeedsApproval('run_javascript', { runJavascriptApproval: 'session' }), true);
  assert.equal(toolNeedsApproval('run_javascript', { runJavascriptApproval: 'each' }), true);
  // 未配置时默认 session → 仍需确认一次
  assert.equal(toolNeedsApproval('run_javascript', {}), true);
});

test('toolNeedsApproval: run_javascript 不参与分类自动批准', () => {
  const allOpen = { toolApprovalPolicy: { read: true, edit: true, commands: true, browser: true, mcp: true } };
  assert.equal(toolNeedsApproval('run_javascript', allOpen), true, '高危工具不应被分类自动批准放行');
  // 对照：普通页面写操作在同类策略下会被放行
  assert.equal(toolNeedsApproval('click_element', allOpen), false);
});

test('toolNeedsApproval: 站点信任放行普通写操作，但不放行高危工具', () => {
  const trusted = { trustedSites: ['https://example.com'], toolApprovalPolicy: {} };
  assert.equal(toolNeedsApproval('click_element', trusted, 'https://example.com/page'), false);
  assert.equal(toolNeedsApproval('add_entry', trusted, 'https://example.com/page'), false);
  // 站点信任的判定在 alwaysRequireApproval 之后，故对 run_javascript 无效
  assert.equal(toolNeedsApproval('run_javascript', trusted, 'https://example.com/page'), true);
});

test('toolNeedsApproval: 未信任站点的写操作仍需审批', () => {
  const trusted = { trustedSites: ['https://example.com'], toolApprovalPolicy: {} };
  assert.equal(toolNeedsApproval('click_element', trusted, 'https://other.com/page'), true);
  // 非法 URL 不应抛错
  assert.equal(toolNeedsApproval('click_element', trusted, 'not a url'), true);
});

// ---------------------------------------------------------------- tool 消息配对

const callAssistant = (ids) => ({
  role: 'assistant',
  content: '',
  tool_calls: ids.map((id) => ({ id, type: 'function', function: { name: 't', arguments: '{}' } })),
});
const toolResult = (id, content = 'ok') => ({ role: 'tool', tool_call_id: id, content });

test('sanitizeToolPairing: assistant.tool_calls 与其结果配对完整时原样保留', () => {
  const out = sanitizeToolPairing([callAssistant(['t1']), toolResult('t1')]);
  assert.equal(out.length, 2);
});

test('sanitizeToolPairing: 缺少结果的 assistant.tool_calls 被剔除', () => {
  const out = sanitizeToolPairing([callAssistant(['t1'])]);
  assert.equal(out.length, 0, '请求非法（有调用无结果）应整条剔除');
});

test('sanitizeToolPairing: 无 provider 的孤儿 tool 结果被剔除', () => {
  const out = sanitizeToolPairing([toolResult('tX')]);
  assert.equal(out.length, 0);
});

test('sanitizeToolPairing: 部分结果缺失时整组剔除，不留孤儿', () => {
  const out = sanitizeToolPairing([callAssistant(['t1', 't2']), toolResult('t1')]);
  assert.equal(out.length, 0, 't2 无结果 → assistant 剔除 → t1 也变孤儿一起剔除');
});

test('sanitizeToolPairing: 混合时保留完整配对、剔除孤儿', () => {
  const out = sanitizeToolPairing([callAssistant(['t1']), toolResult('t1'), toolResult('tX')]);
  assert.equal(out.length, 2);
  assert.ok(!out.some((m) => m.tool_call_id === 'tX'));
});

test('compactSessionMessages: 保留 system + 配对消息', () => {
  const out = compactSessionMessages([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'u' },
    callAssistant(['t1']),
    toolResult('t1'),
  ]);
  assert.equal(out[0].role, 'system');
  assert.equal(out.length, 4);
});

test('compactSessionMessages: 尾部超过 39 条时只保留最近', () => {
  const msgs = [{ role: 'system', content: 'sys' }];
  for (let i = 0; i < 50; i++) msgs.push({ role: 'user', content: 'u' + i });
  const out = compactSessionMessages(msgs);
  assert.equal(out.length, 40);
  assert.equal(out[1].content, 'u11');
});

