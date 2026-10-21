// 审批判定（安全边界）的直接单测。
//
// 这个文件**不 import agent.js** —— 那等于为了测一个纯函数而拖进整个编排循环
// （顶层就摸 chrome API）。这正是这段逻辑之前只有 5 条断言的原因：
// 想测它就得先起一整套 chrome 桩，于是没人测。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  toolNeedsApproval,
  resolveApprovalCategory,
  APPROVAL_CATEGORY_BY_RISK,
  RISK_WITHOUT_CATEGORY,
} from '../lib/assistant/approval-policy.js';
import { TOOL_METADATA } from '../lib/assistant/tool-metadata.js';

const ALL_ON = Object.freeze({ read: true, edit: true, commands: true, browser: true, mcp: true });
const ALL_OFF = Object.freeze({ read: false, edit: false, commands: false, browser: false, mcp: false });

test('risk → 审批类别是显式映射，不依赖默认值兜底', () => {
  // 逐条钉死：这里改一个值就等于改了"哪类工具被自动放行"，必须显式可见。
  assert.equal(resolveApprovalCategory('page'), 'commands');
  assert.equal(resolveApprovalCategory('write'), 'edit');
  assert.equal(resolveApprovalCategory('destructive'), 'edit');
  assert.equal(resolveApprovalCategory('browser'), 'browser');
  assert.equal(resolveApprovalCategory('network'), 'browser');
  assert.equal(resolveApprovalCategory('external'), 'mcp');
  assert.equal(resolveApprovalCategory('read'), 'read');
});

test('高风险档没有类别：不允许被"类别自动批准"兜底', () => {
  assert.equal(resolveApprovalCategory('high'), null);
  assert.equal(resolveApprovalCategory('unknown'), null);
  assert.equal(resolveApprovalCategory(''), null);
  assert.equal(resolveApprovalCategory(undefined), null);
  assert.equal(resolveApprovalCategory(42), null);
});

test('元数据里出现的每个 risk 都必须在映射或"无类别"名单里（新增等级必须显式决策）', () => {
  const seen = new Set();
  for (const meta of Object.values(TOOL_METADATA)) {
    if (meta && typeof meta.risk === 'string') seen.add(meta.risk);
  }
  for (const risk of seen) {
    const mapped = Object.prototype.hasOwnProperty.call(APPROVAL_CATEGORY_BY_RISK, risk);
    const deliberate = RISK_WITHOUT_CATEGORY.includes(risk);
    assert.ok(
      mapped || deliberate,
      '风险等级 "' + risk + '" 既没有审批类别、也没有被登记为"无类别"：' +
        '它会在用户勾了类别自动批准时被静默拦下（或反过来被放行），必须显式决策'
    );
  }
});

test('声明"无类别"的风险，其工具必须真的总是要审批', () => {
  // 反过来校验名单本身：若某工具标了 high 却没有 alwaysRequireApproval，
  // 它就会变成"每次都弹窗且无法通过设置关闭"——安全但违反用户预期，属于标错。
  const offenders = Object.entries(TOOL_METADATA)
    .filter(([, meta]) => meta && RISK_WITHOUT_CATEGORY.includes(meta.risk))
    .filter(([, meta]) => meta.alwaysRequireApproval !== true)
    .map(([name]) => name);
  assert.deepEqual(offenders, [], '这些工具用了"无类别"的风险等级，却没有 alwaysRequireApproval：' + offenders.join(', '));
});

test('只读工具完全不参与审批判定', () => {
  assert.equal(toolNeedsApproval('knowledge_read', { toolApprovalPolicy: ALL_OFF }), false);
  assert.equal(toolNeedsApproval('knowledge_read', {}), false);
});

test('页面命令类：开关决定是否逐次确认', () => {
  assert.equal(toolNeedsApproval('click_element', { toolApprovalPolicy: ALL_ON }), false);
  assert.equal(toolNeedsApproval('click_element', { toolApprovalPolicy: ALL_OFF }), true);
});

test('写类与破坏性操作共用 edit 类别', () => {
  assert.equal(toolNeedsApproval('add_entry', { toolApprovalPolicy: { edit: true } }), false);
  assert.equal(toolNeedsApproval('remove_entry', { toolApprovalPolicy: { edit: true } }), false);
  assert.equal(toolNeedsApproval('remove_entry', { toolApprovalPolicy: { edit: false } }), true);
});

test('任意代码执行档：不受类别自动批准影响，只看它自己的开关', () => {
  for (const tool of ['run_userscript', 'install_userscript', 'save_skill']) {
    assert.equal(
      toolNeedsApproval(tool, { toolApprovalPolicy: ALL_ON }),
      true,
      tool + ' 不能因为"所有类别都自动批准"就放行'
    );
  }
  assert.equal(toolNeedsApproval('run_userscript', { codeExecutionApproval: 'auto', toolApprovalPolicy: ALL_ON }), false);
  assert.equal(toolNeedsApproval('run_userscript', { codeExecutionApproval: 'session', toolApprovalPolicy: ALL_ON }), true);
});

test('任意代码执行档：站点信任也不能放行', () => {
  const settings = {
    toolApprovalPolicy: ALL_ON,
    trustedSites: ['https://trusted.test'],
  };
  assert.equal(
    toolNeedsApproval('run_userscript', settings, 'https://trusted.test/page'),
    true,
    '站点信任是"这个站点的页面操作不用问"，不是"允许在这个站点跑任意代码"'
  );
});

test('站点信任：非代码执行类写操作在信任源上免确认', () => {
  const settings = { toolApprovalPolicy: ALL_OFF, trustedSites: ['https://trusted.test'] };
  assert.equal(toolNeedsApproval('add_entry', settings, 'https://trusted.test/a/b?c=1'), false);
  assert.equal(toolNeedsApproval('add_entry', settings, 'https://other.test/a'), true);
  // 同主机不同端口 = 不同 origin，不能串
  assert.equal(toolNeedsApproval('add_entry', settings, 'https://trusted.test:8443/a'), true);
});

test('站点信任：URL 非法时不抛异常、且不放行', () => {
  const settings = { toolApprovalPolicy: ALL_OFF, trustedSites: ['null'] };
  assert.equal(toolNeedsApproval('add_entry', settings, 'not a url'), true);
});

test('策略缺失一律 fail-closed', () => {
  assert.equal(toolNeedsApproval('click_element', {}), true);
  assert.equal(toolNeedsApproval('click_element'), true);
  assert.equal(toolNeedsApproval('click_element', { toolApprovalPolicy: {} }), true);
  assert.equal(toolNeedsApproval('click_element', { toolApprovalPolicy: { commands: 'true' } }), true, '只认布尔 true');
});

test('未知工具名：默认要审批（模型偶尔会编出不存在的工具名）', () => {
  assert.equal(toolNeedsApproval('totally_made_up_tool', { toolApprovalPolicy: ALL_ON }), true);
});

test('mcp 外部工具落到 mcp 类别', () => {
  assert.equal(toolNeedsApproval('mcp__github__create_issue', { toolApprovalPolicy: { mcp: true } }), false);
  assert.equal(toolNeedsApproval('mcp__github__create_issue', { toolApprovalPolicy: { mcp: false } }), true);
  assert.equal(toolNeedsApproval('mcp__github__create_issue', {}), true);
});
