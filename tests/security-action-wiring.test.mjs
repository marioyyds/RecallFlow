// 安全护栏接线门禁：确保硬拦截不是只存在于策略模块里，却没人调用。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { recordTraceStep } from '../lib/assistant/tools.js';

const AGENT = fs.readFileSync('lib/assistant/agent.js', 'utf8');
const TOOLS = fs.readFileSync('lib/assistant/tools.js', 'utf8');
const COMMANDS = fs.readFileSync('lib/page/commands.js', 'utf8');
const CONTENT = fs.readFileSync('entries/content.js', 'utf8');
const MACROS = fs.readFileSync('lib/assistant/macros.js', 'utf8');

test('动作硬拦截在审批前和 executeTool 内各有一道', () => {
  assert.match(AGENT, /preflightSensitiveToolCall\(tc\.name, tc\.args \|\| \{\}, ctx\)/, 'Agent 必须在审批前预检');
  assert.match(TOOLS, /export async function preflightSensitiveToolCall/, '必须提供统一预检入口');
  assert.match(TOOLS, /const safety = await preflightSensitiveToolCall\(name, args, ctx\)/, 'executeTool 必须兜底，覆盖宏回放等嵌套调用');
  const approvalAt = AGENT.indexOf('preflightSensitiveToolCall(tc.name');
  const approvalReadAt = AGENT.indexOf('readLiveApprovalSettings', approvalAt);
  assert.ok(approvalAt >= 0 && approvalReadAt > approvalAt, '安全预检必须发生在审批之前');
});

test('敏感动作被阻止后 run 进入等待用户状态，而不是继续让模型换工具尝试', () => {
  assert.match(AGENT, /RUN_STATUS\.WAITING_USER_ACTION/, '必须有等待用户操作状态');
  assert.match(AGENT, /reason: 'sensitive-user-action'/, '持久化必须记录安全中止原因');
  assert.match(MACROS, /needsUserAction: true, sensitiveAction: r\.sensitiveAction/, '宏内步骤被拦截时必须向上传播');
});

test('内容脚本在离开页面之前就脱敏正文、快照、console/network', () => {
  assert.match(CONTENT, /text: redactSensitiveText\(payload\.text\)/);
  assert.match(CONTENT, /entries: redactSensitiveData\(entries \|\| \[\]\)/);
  assert.match(CONTENT, /redactPageSnapshot\(pageText\.extractPageSnapshot/);
});

test('type_text 不再回显 valueBefore/valueAfter 或实际输入内容', () => {
  assert.ok(!/valueBefore:\s*before/.test(COMMANDS));
  assert.ok(!/valueAfter:\s*after/.test(COMMANDS));
  assert.match(COMMANDS, /输入内容不回显/);
  assert.ok(!/实际值：/.test(COMMANDS), '不允许在回执里拼真实值');
});

test('宏轨迹遇到明显秘密时拒绝记录（持久化防线）', () => {
  const ctx = { pageUrl: 'https://site.test/', trace: [] };
  recordTraceStep(ctx, 'type_text', { selector: '#q', value: 'sk-test-RF_SECRET_12345678' }, {
    ok: true,
    selector: '#q',
  });
  assert.equal(ctx.trace.length, 0, '含 API Key 的输入不得进入宏轨迹');
});
