// agent_task 风险预算判定（lib/shared/bridge-agent-policy.js）的边界测试。
//
// 这是 agent_task 的安全承重墙：桥接场景下没有面板 UI 可等审批，
// 于是授权形态从「逐次事后批准」换成「开工前一次性声明 allowRisk」。
// 因此这里必须钉死三件事：
//   1. high（任意代码执行 / 第三方脚本）**任何声明都换不到**；
//   2. 未声明类别一律拒绝，且拒绝信息给出可操作路径；
//   3. 未知风险等级 / 未登记工具默认拒绝，不是默认放行。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_BUDGET_RISKS,
  AGENT_NEVER_RISK,
  RISK_TO_CATEGORY,
  normalizeAllowRisk,
  checkAgentToolBudget,
  preApprovedToolNames,
} from '../lib/shared/bridge-agent-policy.ts';
import { TOOL_METADATA } from '../lib/application/agent/tool-metadata.ts';
import { APPROVAL_CATEGORY_BY_RISK } from '../lib/application/agent/approval-policy.ts';

/** 用真实元数据做判定的便捷封装（测的就是真实注册表，不是替身）。 */
function judge(name, rawRisk) {
  const norm = normalizeAllowRisk(rawRisk);
  assert.equal(norm.ok, true, '测试用例的 allowRisk 本身应当合法：' + norm.error);
  return checkAgentToolBudget(name, norm.set, {
    getMetadata: (n) => TOOL_METADATA[n] || {},
  });
}

// ---------------- normalizeAllowRisk ----------------

test('allowRisk：非数组一律报错，而不是当成空声明放过去', () => {
  for (const bad of ['page', 42, { page: true }]) {
    const r = normalizeAllowRisk(bad);
    assert.equal(r.ok, false, '非数组应当报错：' + JSON.stringify(bad));
    assert.match(r.error, /数组/);
  }
  // 缺省/空表示"只允许只读"，这是有意义且安全的默认，不算错误。
  assert.equal(normalizeAllowRisk(undefined).ok, true);
  assert.equal(normalizeAllowRisk([]).ok, true);
});

test('allowRisk：read 自动并入（调用方不必把只读工具列一遍）', () => {
  const r = normalizeAllowRisk([]);
  assert.equal(r.ok, true);
  assert.ok(r.set.has('read'), 'read 应当自动允许');
  assert.equal(r.set.size, 1);
});

test('allowRisk：high 被显式拒绝，并说明只能面板批准', () => {
  const r = normalizeAllowRisk(['read', 'high']);
  assert.equal(r.ok, false, 'high 不得被声明');
  assert.match(r.error, /面板/, '拒绝信息应指出替代路径（面板当次批准）');
  assert.match(r.error, /run_javascript|用户脚本/, '应点名这类工具');
});

test('allowRisk：未知类别报错，绝不静默丢弃一个安全声明', () => {
  const r = normalizeAllowRisk(['page', 'everything']);
  assert.equal(r.ok, false);
  assert.match(r.error, /everything/, '应指出是哪个值不认识');
  assert.match(r.error, /page/, '应列出可用类别');
});

test('allowRisk：大小写与空白被归一化，不因写法差异误判', () => {
  const r = normalizeAllowRisk([' Page ', 'BROWSER']);
  assert.equal(r.ok, true);
  assert.ok(r.set.has('page'));
  assert.ok(r.set.has('browser'));
});

// ---------------- checkAgentToolBudget：高风险永不开放 ----------------

test('高风险工具：任何 allowRisk 都换不到（这是不可协商的一条）', () => {
  // 先把所有 alwaysRequireApproval 的工具找出来，逐个验证。
  const highTools = Object.keys(TOOL_METADATA).filter(
    (n) => TOOL_METADATA[n].alwaysRequireApproval === true || TOOL_METADATA[n].risk === AGENT_NEVER_RISK
  );
  assert.ok(highTools.length > 0, '注册表里应当存在高风险工具（否则这条测试是空转的）');

  // 用最宽的合法声明去试：high 不在 AGENT_BUDGET_RISKS 里，所以它连"最宽"也进不来。
  const widest = normalizeAllowRisk(AGENT_BUDGET_RISKS.slice());
  assert.equal(widest.ok, true);
  for (const name of highTools) {
    const v = checkAgentToolBudget(name, widest.set, { getMetadata: (n) => TOOL_METADATA[n] || {} });
    assert.equal(v.allowed, false, name + ' 属高风险，必须始终被拒');
    assert.match(v.hint, /面板/, name + ' 的拒绝信息应指向面板');
  }
});

// ---------------- checkAgentToolBudget：只读永远允许 ----------------

test('只读工具：不需要声明即可通过（否则清单会退化成列全部只读工具）', () => {
  const readTools = Object.keys(TOOL_METADATA).filter((n) => TOOL_METADATA[n].risk === 'read');
  assert.ok(readTools.length > 0);
  for (const name of readTools) {
    const v = judge(name, []);
    assert.equal(v.allowed, true, name + ' 是只读，应当允许：' + (v.reason || ''));
  }
});

// ---------------- checkAgentToolBudget：未声明即拒绝 + 可操作提示 ----------------

test('写类工具：未声明类别时拒绝，并指出缺哪个类别、怎么补', () => {
  const v = judge('click_element', ['read']); // click_element 是 risk: page
  assert.equal(v.allowed, false);
  assert.equal(v.risk, 'page');
  assert.match(v.reason, /page/, '应说明它属于哪个类别');
  assert.match(v.reason, /不在本次 allowRisk 声明内/, '应说明拒绝原因');
  assert.match(v.hint, /allowRisk/, '应给出补声明的方法');
  assert.match(v.hint, /page/, '应指出要补哪个类别');
});

test('写类工具：声明了对应类别就放行（约束是类别，不是工具白名单）', () => {
  const v = judge('click_element', ['page']);
  assert.equal(v.allowed, true);
  assert.equal(v.risk, 'page');
  assert.equal(v.readOnly, false);
});

test('风险类别判定用的是精确类别，不是"声明了任意写类别就全放"', () => {
  // type_text 是 page，write 是本地数据写入 —— 声明了 write 不该放开 page 动作。
  const v = judge('type_text', ['write']);
  assert.equal(v.allowed, false, '声明 write 不得顺带放开 page 动作');
  assert.equal(v.risk, 'page');
});

// ---------------- 默认拒绝：未知风险 / 未登记工具 ----------------

test('未知风险等级默认拒绝（防止"新增工具忘了标 risk"变成静默提权路径）', () => {
  const v = checkAgentToolBudget('brand_new_tool', new Set(['page', 'write']), {
    getMetadata: () => ({ risk: 'unknown' }),
  });
  assert.equal(v.allowed, false);
  assert.match(v.reason, /没有可用的风险等级/);
});

test('完全没有元数据的工具默认拒绝', () => {
  const v = checkAgentToolBudget('what_is_this', new Set(['page']), { getMetadata: () => ({}) });
  assert.equal(v.allowed, false);
  assert.equal(v.risk, 'unknown');
});

test('缺 getMetadata 依赖时不抛异常，且按默认拒绝处理', () => {
  const v = checkAgentToolBudget('x', new Set(['page']), {});
  assert.equal(v.allowed, false, '拿不到元数据必须默认拒绝，而不是静默放行');
});

// ---------------- 与审批策略的映射不得漂移 ----------------

test('与 approval-policy.js 的 risk → 审批类别映射不得漂移', () => {
  // 本模块刻意复制了映射（为了零依赖），复制就会漂移，因此这里核对权威来源。
  // 注意权威来源已从 agent.js 搬到 lib/assistant/approval-policy.js（纯函数、可直接 import）。
  for (const [risk, category] of Object.entries(RISK_TO_CATEGORY)) {
    assert.equal(
      APPROVAL_CATEGORY_BY_RISK[risk],
      category,
      'risk=' + risk + ' 的类别应仍是 ' + category + '；若改动了审批映射，' +
        'bridge-agent-policy.js 的 RISK_TO_CATEGORY 必须同步'
    );
  }
});

test('AGENT_BUDGET_RISKS 与 agent.js 实际会问审批的类别一致', () => {
  // 凡是会走 toolNeedsApproval 类别判定的 risk，都应当能被 allowRisk 声明；
  // 反过来，能声明的也必须真的存在（没有死条目）。
  const declared = new Set(AGENT_BUDGET_RISKS);
  for (const [risk] of Object.entries(RISK_TO_CATEGORY)) {
    assert.ok(declared.has(risk), 'risk=' + risk + ' 有类别映射，就应当可被声明');
  }
  for (const risk of declared) {
    assert.ok(RISK_TO_CATEGORY[risk], 'risk=' + risk + ' 可被声明，就必须有类别映射');
  }
});

// ---------------- preApprovedToolNames：别卡在"没人能回答的审批"上 ----------------
//
// agent 循环的审批等的是 port 上的面板应答；桥接没有面板，因此会挂到超时。
// 解法是复用循环已有的 sessionApprovedTools，把"本任务已授权"的工具预填进去。
// 但这绝不能变成"顺带把高风险也预填" —— 那会让 §高风险 那条规则失效。

test('preApproved：只填"已声明类别 且 本身会走审批"的工具', () => {
  const names = preApprovedToolNames(new Set(['page']), ['click_element', 'type_text'], {
    getMetadata: (n) => TOOL_METADATA[n] || {},
  });
  assert.deepEqual(names, ['click_element', 'type_text'], '已声明的 page 类应当被预放行（否则会挂到超时）');
});

test('preApproved：绝不包含高风险工具（否则会话级放行就绕过了那条不可协商的规则）', () => {
  const highTools = Object.keys(TOOL_METADATA).filter(
    (n) => TOOL_METADATA[n].alwaysRequireApproval === true || TOOL_METADATA[n].risk === AGENT_NEVER_RISK
  );
  assert.ok(highTools.length > 0);
  // 用最宽的合法声明去试
  const names = preApprovedToolNames(new Set(AGENT_BUDGET_RISKS), [...Object.keys(TOOL_METADATA), ...highTools], {
    getMetadata: (n) => TOOL_METADATA[n] || {},
  });
  for (const t of highTools) {
    assert.ok(!names.includes(t), t + ' 属高风险，绝不能被预放行');
  }
});

test('preApproved：未声明的类别不预放行（预放行范围不得超过授权范围）', () => {
  const names = preApprovedToolNames(new Set(['read']), ['click_element', 'type_text'], {
    getMetadata: (n) => TOOL_METADATA[n] || {},
  });
  assert.deepEqual(names, [], '只声明了 read 时，page 类工具不应被预放行');
});

test('preApproved：只读工具不进清单（它们本来就不弹审批，塞进去只会让清单虚高）', () => {
  const readTools = Object.keys(TOOL_METADATA).filter((n) => TOOL_METADATA[n].risk === 'read');
  const names = preApprovedToolNames(new Set(AGENT_BUDGET_RISKS), readTools, {
    getMetadata: (n) => TOOL_METADATA[n] || {},
  });
  assert.deepEqual(names, [], '只读工具不需要审批，不应出现在预放行清单里');
});

test('preApproved：requiresApproval 未置位的工具不进清单（填了也没有意义）', () => {
  const names = preApprovedToolNames(new Set(['page']), ['made_up_tool'], {
    getMetadata: () => ({ risk: 'page' }), // 没有 requiresApproval: true
  });
  assert.deepEqual(names, []);
});

test('preApproved：空/非法输入不抛异常', () => {
  assert.deepEqual(preApprovedToolNames(new Set(), null, {}), []);
  assert.deepEqual(preApprovedToolNames([], ['x'], {}), []);
});
