// MCP 工具分发：索引必须按运行隔离（曾用模块级全局 Map，并发运行会互相清空）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { collectAgentTools, executeAnyTool } from '../lib/application/agent/mcp.ts';
import { resolveAgentBudgetGuard } from '../lib/application/agent/agent.ts';

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

// ---------------- 风险预算守卫（桥接驱动 agent 的执行前判定） ----------------
//
// 这是 agent_task 的安全承重墙：桥接场景没有面板可弹审批，
// 因此授权是"开工前声明 allowRisk + 执行前逐个判定"。
// 判定挂在 executeAnyTool 这一处汇合点（串行与并行两条路径都经过它），
// 所以只要这里真的拦得住，就不需要动 agent 循环的审批逻辑。
// 下面这几条证明的是"**真的没执行**"，而不只是"返回了错误文本"。

test('executeAnyTool: agentBudgetGuard 拒绝时不得执行工具，且把原因与提示一并返回', async () => {
  let executed = false;
  const ctx = {
    agentBudgetGuard: () => ({
      allowed: false,
      reason: '工具「click_element」不在本次 allowRisk 声明内。',
      hint: '需要它就在 allowRisk 里加上 "page"。',
    }),
    // 放一个会记录"是否被执行"的替身：真的走到执行就能看出来。
    mcpIndex: new Map([['mcp__srv__t', { serverId: 'srv', origName: 't', client: { async callTool() { executed = true; return 'x'; } } }]]),
  };
  const r = await executeAnyTool('mcp__srv__t', {}, ctx);
  assert.equal(executed, false, '被拒时必须**不执行**，而不是先执行再报错');
  assert.equal(r.ok, false);
  assert.match(String(r.result), /allowRisk/, '应把拒绝原因带回给模型');
  assert.match(String(r.result), /page/, '应带上可操作提示（缺哪个类别）');
});

test('executeAnyTool: agentBudgetGuard 放行时照常执行（守卫不能把正常调用挡死）', async () => {
  let executed = false;
  const ctx = {
    agentBudgetGuard: () => ({ allowed: true, risk: 'external' }),
    mcpIndex: new Map([['mcp__srv__t', { serverId: 'srv', origName: 't', client: { async callTool() { executed = true; return '远端结果'; } } }]]),
  };
  const r = await executeAnyTool('mcp__srv__t', {}, ctx);
  assert.equal(executed, true, '放行后必须真的执行');
  assert.equal(r.result, '远端结果');
});

test('executeAnyTool: 没有守卫时行为完全不变（面板路径不受影响）', async () => {
  let executed = false;
  const ctx = {
    mcpIndex: new Map([['mcp__srv__t', { serverId: 'srv', origName: 't', client: { async callTool() { executed = true; return 'ok'; } } }]]),
  };
  const r = await executeAnyTool('mcp__srv__t', {}, ctx);
  assert.equal(executed, true, '不带守卫时不应被拦');
  assert.equal(r.result, 'ok');
});

test('executeAnyTool: schema 校验失败时报参数错误，而不是报未授权', async () => {
  // 参数本身错的时候，更该报的是"参数不对"——否则调用方会去改 allowRisk，而问题在参数。
  // 用 type_text（required: ["value"]）触发真正的 schema 失败：
  // 注意 click_element 之类**没有** required，空参数能过 schema 校验
  //（定位参数是桥接策略那一层的判据，不是 schema 的）。
  let guardCalled = false;
  const ctx = {
    agentBudgetGuard: () => { guardCalled = true; return { allowed: false, reason: '不应走到这里', hint: '' }; },
  };
  const r = await executeAnyTool('type_text', {}, ctx);
  assert.equal(guardCalled, false, '参数校验失败时不应进入授权判定');
  assert.equal(r.ok, false);
  assert.match(String(r.result), /缺少必填参数/, '应报缺少参数，而不是未授权');
});

test('executeAnyTool: 守卫抛异常不得让整轮崩掉（只读守卫失败应可归因）', async () => {
  const ctx = {
    agentBudgetGuard: () => { throw new Error('守卫内部错误'); },
  };
  // 抛出来是可接受的（调用方能看到栈），但必须是可归因的异常，而不是静默放行。
  await assert.rejects(() => executeAnyTool('click_element', { ref: 'rf-1' }, ctx), /守卫内部错误/);
});

// ---------------- 守卫的**接线**必须有牙齿 ----------------
//
// 这一组的存在理由是一次真实的自查发现：守卫最初被写成 ctx.agentBudgetGuard，
// 但 runAgentStream **自己造 ctx**，调用方根本没有参数能塞进去 ——
// 于是判定永不生效、也不会报错，只会静默放行。
// 对一条安全边界来说，"没生效"比"报错"危险得多，所以把它钉成门禁。
//
// 这里用行为断言（直接调用取守卫的纯函数）；relay → settings 的那段接线由
// tests/relay-dispatch.test.mjs 的注入 runner 行为测试覆盖。

test('接线：从 settings 取 guard，且只认函数', () => {
  const guard = () => ({ allowed: true });
  assert.equal(resolveAgentBudgetGuard({ agentBudgetGuard: guard }), guard);
  assert.equal(resolveAgentBudgetGuard({}), undefined, '没有 guard 时必须是 undefined（面板路径不拦）');
  assert.equal(resolveAgentBudgetGuard(null), undefined);
  assert.equal(resolveAgentBudgetGuard({ agentBudgetGuard: 'not-a-fn' }), undefined, '非函数不得被当成守卫');
});
