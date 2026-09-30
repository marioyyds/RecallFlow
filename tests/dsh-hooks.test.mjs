// DSH hook → 面板事件的映射测试。
//
// 这层映射决定"面板上会显示 DSH 会话里的什么"，而且有两条**刻意**的规则必须钉住：
//   1. 跳过 mcp__* 工具（RecallFlow 自己的 MCP 工具已由服务端以更细粒度上报，重复会让面板画两遍）
//   2. 没有可显示内容的钩子点必须产出 null（而不是造一个空事件去刷屏）
import test from 'node:test';
import assert from 'node:assert/strict';

import { toPanelEvent } from '../integrations/dsh-hooks/recallflow-panel-hook.mjs';
import { normalizeExternalEvent, isValidEvent } from '../integrations/opencode/recallflow-mcp/panel-events.js';

test('toPanelEvent: UserPromptSubmit → 用户留言（who=user，不能显示成 agent 的话）', () => {
  const ev = toPanelEvent({ hook_event_name: 'UserPromptSubmit', prompt: '帮我看下这个页面的报错' });
  assert.deepEqual(ev, { text: '帮我看下这个页面的报错', level: 'info', who: 'user' });
});

test('toPanelEvent: PreToolUse → 工具开始事件，带参数', () => {
  const ev = toPanelEvent({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.equal(ev.kind, 'tool');
  assert.equal(ev.phase, 'start');
  assert.equal(ev.tool, 'Bash');
  assert.deepEqual(ev.args, { command: 'ls' });
});

test('toPanelEvent: PostToolUse → 工具结束事件', () => {
  const ev = toPanelEvent({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {} });
  assert.equal(ev.kind, 'tool');
  assert.equal(ev.phase, 'end');
  assert.equal(ev.ok, true);
});

test('toPanelEvent: 跳过 mcp__* 工具（否则同一次调用会被画两遍）', () => {
  for (const name of ['mcp__recallflow__read_console', 'mcp__other__x']) {
    assert.equal(toPanelEvent({ hook_event_name: 'PreToolUse', tool_name: name }), null, '应跳过 ' + name);
    assert.equal(toPanelEvent({ hook_event_name: 'PostToolUse', tool_name: name }), null, '应跳过 ' + name);
  }
  // 但非 mcp 的前缀不该被误伤
  assert.ok(toPanelEvent({ hook_event_name: 'PreToolUse', tool_name: 'mcpX' }));
});

test('toPanelEvent: 没有可显示内容的钩子点与脏载荷都返回 null', () => {
  const cases = [
    { hook_event_name: 'Stop', stop_hook_active: false },
    { hook_event_name: 'SessionStart' },
    { hook_event_name: 'SubagentStop' },
    { hook_event_name: 'UserPromptSubmit', prompt: '' },
    { hook_event_name: 'UserPromptSubmit' },
    { hook_event_name: 'PreToolUse' },
    { hook_event_name: 'PreToolUse', tool_name: '' },
    {},
    null,
    'x',
  ];
  for (const c of cases) {
    assert.equal(toPanelEvent(c), null, '应返回 null：' + JSON.stringify(c));
  }
});

test('normalizeExternalEvent: 宽松接受 hook 送来的几种形态', () => {
  // say（hook 用 who=user 表示"用户说的"）
  const user = normalizeExternalEvent({ text: '你好', who: 'user' }, 1000);
  assert.equal(user.kind, 'say');
  assert.equal(user.who, 'user');
  assert.equal(user.source, 'external');
  assert.equal(user.at, 1000);
  assert.ok(isValidEvent(user));

  // 显式 kind
  const say = normalizeExternalEvent({ kind: 'say', text: 'hi', level: 'warn' }, 1);
  assert.equal(say.level, 'warn');
  assert.equal(say.who, 'dsh', '未指定 who 时归给 agent');

  // tool start / end
  const t1 = normalizeExternalEvent({ kind: 'tool', tool: 'Bash', args: { command: 'ls' } }, 2);
  assert.equal(t1.phase, 'start');
  assert.equal(t1.source, 'external');
  assert.ok(isValidEvent(t1));

  const t2 = normalizeExternalEvent({ kind: 'tool', phase: 'end', tool: 'Bash', ok: false, error: 'boom' }, 3);
  assert.equal(t2.phase, 'end');
  assert.equal(t2.ok, false);
  assert.equal(t2.error, 'boom', '字符串错误原样显示');
  assert.ok(isValidEvent(t2));
  // Error 实例走另一条格式化路径（'name: message'），在 panel-events.test.mjs 里单独钉住
  assert.equal(normalizeExternalEvent({ kind: 'tool', phase: 'end', tool: 'Bash', error: new Error('x') }, 1).error, 'Error: x');

  // 有 tool 无 text 也识别为工具
  assert.equal(normalizeExternalEvent({ tool: 'Read' }, 4).kind, 'tool');
});

test('normalizeExternalEvent: 无法识别时返回 null（调用方据此返回 ok:false，不静默吞掉）', () => {
  for (const bad of [null, undefined, 'x', 42, {}, { text: '' }, { kind: 'tool' }, { tool: '' }, { text: '   ' }]) {
    assert.equal(normalizeExternalEvent(bad), null, '应拒绝：' + JSON.stringify(bad));
  }
});
