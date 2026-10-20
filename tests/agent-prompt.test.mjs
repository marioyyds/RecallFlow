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
  // knowledge_read 是 C-4 合并后的只读入口（原 search_knowledge_base），同样应直接放行。
  assert.equal(toolNeedsApproval('knowledge_read', { toolApprovalPolicy: { read: false, commands: false } }), false);
  assert.equal(toolNeedsApproval('web_search', { toolApprovalPolicy: { browser: false } }), false);
  assert.equal(toolNeedsApproval('get_page_snapshot', { toolApprovalPolicy: {} }), false);
});

test('toolNeedsApproval: run_javascript 归入页面命令类别', () => {
  const policy = (commands) => ({ toolApprovalPolicy: { commands } });
  assert.equal(toolNeedsApproval('run_javascript', policy(true)), false);
  assert.equal(toolNeedsApproval('run_javascript', policy(false)), true);
  // 与 click_element 同类别：不再单独受 codeExecutionApproval 控制
  assert.equal(toolNeedsApproval('run_javascript', { codeExecutionApproval: 'auto', toolApprovalPolicy: { commands: false } }), true);
});

test('toolNeedsApproval: 任意代码执行档必须独立审批（不受类别自动批准 / 站点信任影响）', () => {
  // 为什么单独一条：这三个工具（risk:'high' + alwaysRequireApproval）此前**零测试**，
  // 是变异测试把它们挖出来的 —— 把 `alwaysRequireApproval` 那个分支改成恒 false，
  // 全套测试**没有任何一条变红**。
  //
  // 后果为什么严重：risk:'high' 并不在 risk→category 映射里，所以这个分支一旦失效，
  // 它们会落到默认的 'commands' 类别 —— 用户勾了「页面命令自动批准」，
  // 就等于给"在页面里执行任意代码"开了闸，而这个关联在设置界面上完全看不出来。
  const ALL_CATEGORIES_AUTO = { toolApprovalPolicy: { commands: true, edit: true, browser: true, mcp: true } };
  const GATED = ['run_userscript', 'install_userscript', 'save_skill'];

  for (const name of GATED) {
    assert.equal(toolNeedsApproval(name, ALL_CATEGORIES_AUTO), true, name + '：所有类别自动批准也必须逐个审批');
    assert.equal(
      toolNeedsApproval(name, { ...ALL_CATEGORIES_AUTO, codeExecutionApproval: 'auto' }),
      false,
      name + '：只有用户**显式**选择 auto 才放行'
    );
  }

  // 'session' 仍需弹一次（之后由会话级放行负责），'each' 每次都要问
  assert.equal(toolNeedsApproval('run_userscript', { codeExecutionApproval: 'session' }), true);
  assert.equal(toolNeedsApproval('run_userscript', { codeExecutionApproval: 'each' }), true);
  // 非法值回落到 session（settings.js 的约定），仍然要审批
  assert.equal(toolNeedsApproval('run_userscript', { codeExecutionApproval: 'whatever' }), true);

  // 站点信任是"这个站点的写操作不用反复确认"，不等于"同意在我机器上跑任意代码"
  assert.equal(
    toolNeedsApproval(
      'run_userscript',
      { ...ALL_CATEGORIES_AUTO, trustedSites: ['https://a.example'] },
      'https://a.example/page'
    ),
    true,
    '信任站点不得绕过代码执行审批'
  );
});

test('toolNeedsApproval: 站点信任放行普通写操作，也覆盖页面命令里的 run_javascript', () => {
  const trusted = { trustedSites: ['https://example.com'], toolApprovalPolicy: {} };
  assert.equal(toolNeedsApproval('click_element', trusted, 'https://example.com/page'), false);
  assert.equal(toolNeedsApproval('add_entry', trusted, 'https://example.com/page'), false);
  assert.equal(toolNeedsApproval('run_javascript', trusted, 'https://example.com/page'), false);
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

// ⚠ 这条用例**被改写过**（旧版本断言 `out.length === 40` 且 `out[1].content === 'u11'`）：
// 那两个断言把**静默丢弃**当契约钉住了 —— 落盘快照会丢 11 条消息，而恢复时模型看到的
// 只是"对话就这么短"，没有任何提示 ✗。现在断言更严：既要有说明，也要保住最近 39 条。
test('compactSessionMessages: 尾部超过 39 条时只保留最近，且**必须说明丢了多少**', () => {
  const msgs = [{ role: 'system', content: 'sys' }];
  for (let i = 0; i < 50; i++) msgs.push({ role: 'user', content: 'u' + i });
  const out = compactSessionMessages(msgs);
  assert.equal(out[0].role, 'system');
  assert.equal(out.length, 41, 'system + 1 条说明 + 最近 39 条');
  assert.match(out[1].content, /更早的 11 条消息未随快照保存/, '丢了多少必须写明：' + JSON.stringify(out[1].content));
  assert.match(out[1].content, /取不回原文/, '这类消息没有 id 可给 ⇒ 必须明说取不回（A5 判据）');
  assert.equal(out[2].content, 'u11', '保住的是最近 39 条');
  assert.equal(out[out.length - 1].content, 'u49');

  // 没丢东西时不许凭空多出说明（避免每次都塞废话）
  const short = compactSessionMessages([{ role: 'system', content: 'sys' }, { role: 'user', content: 'u' }]);
  assert.equal(short.length, 2);
  assert.ok(!short.some((m) => /未随快照保存/.test(String(m.content))));
});

test('compactSessionMessages: 单条超长时**留尾 + 前置说明**（静默 slice 会让恢复后的模型看不到开头）', () => {
  const long = 'A'.repeat(13000) + 'TAIL_MARK';
  const out = compactSessionMessages([{ role: 'user', content: long }]);
  assert.equal(out.length, 1);
  const text = out[0].content;
  assert.match(text, /只保留末尾/, '必须说明被截掉的是开头：' + text.slice(0, 40));
  assert.match(text, /共 13009 字符/);
  assert.match(text, /取不回原文/, '要明说取不回（没有 id 可给）');
  assert.ok(text.endsWith('TAIL_MARK'), '保留的应当是**尾部**（结论通常在后面）');
  // 正常长度逐字节不变
  const ok = compactSessionMessages([{ role: 'user', content: 'A'.repeat(12000) }]);
  assert.equal(ok[0].content, 'A'.repeat(12000), '正好等于上限时一个字都不许多');
});

