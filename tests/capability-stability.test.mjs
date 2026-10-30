// 跨意图/跨用户回合的 capability surface 稳定性。
//
// function-calling 的工具定义位于 messages 之前。只要 tools 随意图变化，
// 即使消息本身 append-only，服务端也会从 token 0 开始失配。这里把
// 「完整、稳定、确定性排序的工具面」与「每轮追加的任务策略」钉成契约。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildInitialMessagesPure,
} from '../lib/application/agent/initial-messages.ts';
import {
  INTENTS,
  buildStableSystemPrompt,
  buildTaskPolicyPrompt,
  isToolAllowedForIntent,
} from '../lib/application/agent/intent-router.ts';
import { collectAgentTools } from '../lib/application/agent/mcp.ts';

const allTools = await collectAgentTools({}, { includeMcp: false });
const toolNames = allTools.tools.map((tool) => tool.function.name);
const stableSystem = buildStableSystemPrompt(toolNames, []);

test('稳定工具面包含全部注册工具，且重复收集逐字节一致', async () => {
  const again = await collectAgentTools({}, { includeMcp: false });
  assert.deepEqual(
    again.tools.map((tool) => tool.function.name),
    toolNames,
    '工具顺序必须确定；不能因运行次数或任务类型重排 function schema'
  );
  assert.equal(
    JSON.stringify(again.tools),
    JSON.stringify(allTools.tools),
    '同一配置下必须得到逐字节一致的 function schema'
  );
});
test('不同意图使用同一 system 前缀，任务策略只追加在历史之后', () => {
  const cases = [
    [INTENTS.BROWSER, '打开百度搜索今天的热搜'],
    [INTENTS.KNOWLEDGE, '我的收藏里有没有 nginx 笔记'],
    [INTENTS.RESEARCH, '总结这篇论文'],
    [INTENTS.CHAT, '你好'],
  ];
  const prefixes = new Set();
  for (const [intent, instruction] of cases) {
    const messages = buildInitialMessagesPure({
      systemPrompt: stableSystem,
      history: [
        { role: 'user', content: '上一轮用户消息' },
        { role: 'assistant', content: '上一轮回答' },
      ],
      taskSystemPrompt: buildTaskPolicyPrompt(intent, instruction),
      instruction,
      instructionToken: 'fixed-test-token',
    });
    assert.equal(messages[0].content, stableSystem);
    assert.equal(messages[1].content, '上一轮用户消息');
    assert.equal(messages[2].content, '上一轮回答');
    assert.equal(messages[3].role, 'system');
    assert.match(messages[3].content, /本次任务策略/);
    assert.equal(messages[4].role, 'user');
    prefixes.add(messages[0].content);
  }
  assert.equal(prefixes.size, 1, '意图切换不得改写 messages[0]');
  assert.ok(!stableSystem.includes('目标关键词'), '当前指令关键词属于任务后缀，不得进入稳定前缀');
});

test('意图白名单改为执行期权限：schema 可见不等于当前任务可执行', () => {
  assert.equal(isToolAllowedForIntent(INTENTS.BROWSER, 'type_text'), true);
  assert.equal(isToolAllowedForIntent(INTENTS.BROWSER, 'knowledge_read'), false);
  assert.equal(isToolAllowedForIntent(INTENTS.KNOWLEDGE, 'click_element'), false);
  assert.equal(isToolAllowedForIntent(INTENTS.CHAT, 'run_javascript'), false);
  assert.equal(isToolAllowedForIntent(INTENTS.CHAT, 'update_plan'), true, 'alwaysAvailable 工具跨意图常驻');
  assert.equal(isToolAllowedForIntent(INTENTS.CHAT, 'mcp__server__tool'), true, 'MCP 由审批策略控制');
  assert.equal(
    isToolAllowedForIntent(INTENTS.CHAT, 'click_element', ['click_element']),
    true,
    '已加载技能声明的工具可显式放行'
  );
});
