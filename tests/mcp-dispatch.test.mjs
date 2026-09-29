// MCP 工具分发：索引必须按运行隔离（曾用模块级全局 Map，并发运行会互相清空）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { collectAgentTools, executeAnyTool } from '../lib/assistant/mcp.js';

test('collectAgentTools: 返回 {tools, mcpIndex} 结构', async () => {
  const r = await collectAgentTools({}, { includeMcp: false });
  assert.ok(Array.isArray(r.tools), 'tools 应为数组');
  assert.ok(r.mcpIndex instanceof Map, 'mcpIndex 应为 Map');
  assert.equal(r.mcpIndex.size, 0);
  assert.ok(r.tools.length > 0, '应包含内置工具');
});

test('collectAgentTools: 按意图白名单过滤内置工具', async () => {
  const r = await collectAgentTools({}, { allowedTools: ['click_element'], includeMcp: false });
  const names = r.tools.map((t) => t.function.name);
  assert.ok(names.includes('click_element'));
  assert.ok(!names.includes('open_tab'), names.join(','));
});

test('collectAgentTools: 两次收集得到相互独立的索引对象', async () => {
  const a = await collectAgentTools({}, { includeMcp: false });
  const b = await collectAgentTools({}, { includeMcp: false });
  assert.notEqual(a.mcpIndex, b.mcpIndex, '不应共享同一个 Map 实例');
});

test('executeAnyTool: 缺少运行索引时给出可读错误而非抛异常', async () => {
  const r = await executeAnyTool('mcp__srv__tool', {}, {});
  assert.ok(String(r.result).includes('未知 MCP 工具'), r.result);
});

test('executeAnyTool: 用 ctx.mcpIndex 分发到正确的 client 与原工具名', async () => {
  const calls = [];
  const client = {
    async callTool(name, args) {
      calls.push([name, args]);
      return '远端结果';
    },
  };
  const mcpIndex = new Map([['mcp__srv__thing', { serverId: 'srv', origName: 'thing', client }]]);
  const r = await executeAnyTool('mcp__srv__thing', { a: 1 }, { mcpIndex });
  assert.deepEqual(calls, [['thing', { a: 1 }]]);
  assert.equal(r.result, '远端结果');
});

test('executeAnyTool: 两个并发运行各自持有索引，互不干扰（关键回归）', async () => {
  // 复现原缺陷场景：运行 A 已加载索引，运行 B 收集工具时清空了全局索引，
  // 导致 A 的下一次调用报「未知 MCP 工具」。现在索引随 ctx 传递，不会互相影响。
  const makeCtx = (tag) => ({
    mcpIndex: new Map([
      [
        'mcp__s__t',
        {
          serverId: 's',
          origName: 't',
          client: { async callTool() { return tag; } },
        },
      ],
    ]),
  });
  const ctxA = makeCtx('A');
  const ctxB = makeCtx('B');
  const ra = await executeAnyTool('mcp__s__t', {}, ctxA);
  const rb = await executeAnyTool('mcp__s__t', {}, ctxB);
  const ra2 = await executeAnyTool('mcp__s__t', {}, ctxA);
  assert.equal(ra.result, 'A');
  assert.equal(rb.result, 'B');
  assert.equal(ra2.result, 'A', 'B 的收集不应影响 A');
});

test('executeAnyTool: MCP 调用失败返回错误文本而不抛出', async () => {
  const mcpIndex = new Map([
    ['mcp__s__t', { serverId: 's', origName: 't', client: { async callTool() { throw new Error('连接断开'); } } }],
  ]);
  const r = await executeAnyTool('mcp__s__t', {}, { mcpIndex });
  assert.ok(String(r.result).includes('连接断开'), r.result);
});

test('executeAnyTool: 内置工具仍走 executeTool（参数校验生效）', async () => {
  const r = await executeAnyTool('完全不存在的工具', {}, {});
  assert.ok(String(r.result).includes('未知工具'), r.result);
});
