// 审批设置的**实时性**门禁：用户对话进行中改了开关，本轮必须立刻生效。
//
// ## 起因（用户报的真实问题）
//
// 「最开始没有打开自动批准，在对话过程中打开，RecallFlow 还是对话要进行批准确认。」
//
// 根因：`settings` 是**每次运行开始时**读的一份快照（background.js 在 runAgentStream
// 之前 `getAISettings()` 一次），运行期间从不重读。用户打开自动批准后，本轮剩下的
// 写操作仍然一个个弹确认，只有**下一次**运行才生效。
//
// 而且这条缺陷有**两个方向**，后者更严重：
//   · 快照说"要审批"、用户已关掉 → 白弹确认（用户报的）；
//   · 快照说"无需审批"、用户已打开 → 一次本该确认的写操作**直接执行**（漏批）。
// 所以修复不是"读到新值就用"，而是**每次都现读**。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const agentSrc = fs.readFileSync('lib/application/agent/agent.ts', 'utf8');

// `lib/application/agent/agent.ts` 在模块顶层会 import 一堆东西，但不会在 import 期访问 chrome，
// 因此这里可以直接导入纯函数（另有测试用同样的方式导入它）。
const { readLiveApprovalSettings, toolNeedsApproval } = await import('../lib/application/agent/agent.ts');

test('现读的设置覆盖快照里的四个审批字段', async () => {
  const snapshot = {
    apiKey: 'k',
    model: 'snapshot-model',
    toolApproval: true,
    toolApprovalPolicy: { read: true, edit: false, commands: false, browser: false, mcp: false },
    trustedSites: ['https://a.test'],
    codeExecutionApproval: 'each',
  };
  const live = await readLiveApprovalSettings(snapshot, async () => ({
    toolApproval: true,
    toolApprovalPolicy: { read: true, edit: true, commands: true, browser: true, mcp: true },
    trustedSites: ['https://b.test'],
    codeExecutionApproval: 'auto',
  }));
  assert.deepEqual(live.toolApprovalPolicy, { read: true, edit: true, commands: true, browser: true, mcp: true });
  assert.deepEqual(live.trustedSites, ['https://b.test']);
  assert.equal(live.codeExecutionApproval, 'auto');
  // 与审批无关的字段**原样保留**（现读只是为了审批，不该把整份设置换掉）
  assert.equal(live.apiKey, 'k');
  assert.equal(live.model, 'snapshot-model');
});

test('现读之后，类别开关立刻改变"要不要审批"这个判断', () => {
  const snapshot = { toolApprovalPolicy: { read: true, edit: false, commands: false, browser: false, mcp: false } };
  const live = { toolApprovalPolicy: { read: true, edit: true, commands: true, browser: true, mcp: true } };
  // type_text 是 risk:'page' → 类别 'commands'
  assert.equal(toolNeedsApproval('type_text', snapshot, 'https://a.test/p'), true, '快照：仍要审批');
  assert.equal(toolNeedsApproval('type_text', live, 'https://a.test/p'), false, '现读：已放行');
});

test('站点信任同样立刻生效（它也是审批输入之一）', () => {
  const base = { toolApprovalPolicy: { read: true, edit: false, commands: false, browser: false, mcp: false } };
  assert.equal(toolNeedsApproval('add_entry', base, 'https://a.test/p'), true);
  assert.equal(
    toolNeedsApproval('add_entry', Object.assign({}, base, { trustedSites: ['https://a.test'] }), 'https://a.test/p'),
    false
  );
});

test('读设置失败时**沿用快照**：宁可多确认一次，也不能因此放行写操作', async () => {
  const snapshot = { toolApprovalPolicy: { read: true, edit: false, commands: false, browser: false, mcp: false } };
  const live = await readLiveApprovalSettings(snapshot, async () => {
    throw new Error('存储读失败');
  });
  assert.deepEqual(live, snapshot, '读失败必须原样退回快照');
  assert.equal(toolNeedsApproval('type_text', live, 'https://a.test/p'), true, 'fail-closed：仍然要审批');
});

test('现读到一份"没有审批字段"的设置时，也必须退回到"要审批"', async () => {
  const board = { toolApprovalPolicy: { read: true, edit: true, commands: true, browser: true, mcp: true } };
  const live = await readLiveApprovalSettings(board, async () => ({}));
  assert.deepEqual(live.toolApprovalPolicy, {}, '缺失时给空对象，而不是保留旧的宽松值');
  assert.equal(toolNeedsApproval('type_text', live, 'https://a.test/p'), true, '空策略 = 一律要审批');
});

test('缺省 loader 在没有 chrome 的环境里也不会抛（单元测试场景）', async () => {
  const snapshot = { toolApprovalPolicy: { read: true } };
  const live = await readLiveApprovalSettings(snapshot);
  assert.deepEqual(live, snapshot, '取不到设置时应静默退回快照');
});

// ---------------- 源码级门禁：审批判断不许再用那份运行开始时的快照 ----------------

test('串行路径：审批判断前必须现读，且判断用的是现读结果', () => {
  const at = agentSrc.indexOf('toolNeedsApproval(tc.name,');
  assert.ok(at > -1, '应能找到循环里的审批判断');
  const before = agentSrc.slice(Math.max(0, at - 900), at);
  assert.match(
    before,
    /approvalSettings = await readLiveApprovalSettings\(settings\)/,
    '审批判断前必须现读设置 —— 否则用户中途打开自动批准不会生效'
  );
  assert.match(agentSrc.slice(at, at + 120), /toolNeedsApproval\(tc\.name, approvalSettings,/, '判断必须用现读结果');
  // 反例：直接用运行开始时的快照必须被判为不合格
  const bad = "if (settings.toolApproval !== false && toolNeedsApproval(tc.name, settings, ctx.pageUrl)) {";
  assert.ok(!/approvalSettings = await readLiveApprovalSettings/.test(bad), '朴素写法不含现读，应判不合格');
});

test('代码执行审批的会话放行也读现读结果（同一个坑的第三个入口）', () => {
  const at = agentSrc.indexOf('const allowSession =');
  assert.ok(at > -1);
  assert.match(agentSrc.slice(at, at + 220), /resolveCodeExecutionApproval\(approvalSettings\)/);
});

// ---------------- 设置写回：不许拿"打开面板时读到的旧值"当基底 ----------------

test('updateAISettings：局部更新不许把其它字段回写成旧值', async () => {
  const store = { aiSettings: { model: 'old-model', toolApprovalPolicy: { read: true } } };
  globalThis.chrome = {
    storage: {
      local: {
        get: async (k) => ({ [k]: store[k] }),
        set: async (o) => Object.assign(store, o),
      },
    },
  };
  const { updateAISettings } = await import('../lib/shared/settings.ts');
  // 模拟"面板打开时读到 model=old-model，之后用户把它改成了 new-model"
  store.aiSettings.model = 'new-model';
  const merged = await updateAISettings({ toolApprovalPolicy: { read: true, commands: true } });
  assert.equal(store.aiSettings.model, 'new-model', '不得把模型回写成旧值');
  assert.deepEqual(store.aiSettings.toolApprovalPolicy, { read: true, commands: true });
  assert.equal(merged.model, 'new-model');
  globalThis.chrome = undefined;
});

test('这条门禁有牙齿：用缓存旧基底合并，确实会覆盖其它字段', () => {
  const staleBase = { model: 'old-model', toolApprovalPolicy: { read: true } }; // 面板打开时读到的
  const naive = Object.assign({}, staleBase, { toolApprovalPolicy: { read: true, commands: true } });
  assert.equal(naive.model, 'old-model', '朴素写法会把模型回写 —— 这正是被修掉的缺陷');
  // 而现读基底的写法保留用户的新值
  const freshBase = { model: 'new-model', toolApprovalPolicy: { read: true } };
  const fixed = Object.assign({}, freshBase, { toolApprovalPolicy: { read: true, commands: true } });
  assert.equal(fixed.model, 'new-model');
});
