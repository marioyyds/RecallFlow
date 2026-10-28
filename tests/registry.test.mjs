import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_REGISTRY, getToolMetadata, validateToolCall, BUILTIN_TOOLS } from '../lib/application/agent/tools.ts';
import { TOOL_SCHEMAS } from '../lib/application/agent/tool-schemas.ts';
import { TOOL_METADATA } from '../lib/application/agent/tool-metadata.ts';
import { resolveIntent, INTENTS } from '../lib/application/agent/intent-router.ts';

const NAMES = TOOL_SCHEMAS.map((t) => t && t.function && t.function.name);

test('every tool has a name, object schema and risk', () => {
  assert.ok(TOOL_REGISTRY.length > 0);
  for (const t of TOOL_REGISTRY) {
    assert.ok(t.name, 'tool name');
    assert.equal(t.inputSchema.type, 'object', t.name + ' schema type');
    assert.ok(typeof t.risk === 'string', t.name + ' risk');
  }
  assert.equal(BUILTIN_TOOLS.length, TOOL_REGISTRY.length);
});

test('run_javascript 归入页面命令审批', () => {
  const md = getToolMetadata('run_javascript');
  assert.equal(md.risk, 'page');
  assert.equal(md.requiresApproval, true);
  assert.ok(!md.alwaysRequireApproval, '不再单独占用逐次审批档');
});

test('load_skill is always available across intents', () => {
  assert.equal(getToolMetadata('load_skill').alwaysAvailable, true);
});

test('validateToolCall enforces required params', () => {
  assert.equal(validateToolCall('click_at', {}).ok, false);
  assert.equal(validateToolCall('click_at', { x: 1, y: 2 }).ok, true);
  assert.equal(validateToolCall('unknown_tool', {}).ok, false);
});

// ---------------------------------------------------------------- 注册表一致性门禁
//
// 为什么需要：TOOL_REGISTRY 对**缺失**的 TOOL_METADATA 条目会静默降级为
// `{ risk: 'unknown', requiresApproval: true, route: 'background' }`
// —— 新增工具却忘了登记元数据时不会报错，只表现成「权限判定莫名其妙」。
// 下列用例把这类漂移变成红灯。

test('每个 schema 都必须登记元数据（否则被静默降级为 unknown 风险）', () => {
  const missing = NAMES.filter((n) => !n || !Object.prototype.hasOwnProperty.call(TOOL_METADATA, n));
  assert.deepEqual(missing, [], '以下工具缺少 TOOL_METADATA 条目：' + missing.join('、'));
});

test('元数据里不得存在没有对应 schema 的孤儿条目', () => {
  const declared = new Set(NAMES.filter(Boolean));
  const orphans = Object.keys(TOOL_METADATA).filter((k) => !declared.has(k));
  assert.deepEqual(orphans, [], '以下元数据没有对应工具（改名后忘了删）：' + orphans.join('、'));
});

test('工具名唯一，且符合 function-calling 的命名约束', () => {
  const seen = new Set();
  const dup = [];
  for (const n of NAMES) {
    if (!n) {
      dup.push('(空名)');
      continue;
    }
    if (seen.has(n)) dup.push(n);
    seen.add(n);
  }
  assert.deepEqual(dup, [], '重复或空工具名：' + dup.join('、'));
  for (const n of seen) {
    assert.match(n, /^[a-zA-Z0-9_-]{1,64}$/, '工具名不符合约束：' + n);
  }
});

test('每个 schema 结构完整（description 不能糊弄，properties 必须存在）', () => {
  for (const t of TOOL_SCHEMAS) {
    assert.equal(t.type, 'function', 'type 必须是 function');
    assert.ok(t.function && typeof t.function === 'object');
    assert.ok(t.function.name, '缺少 name');
    assert.ok(
      typeof t.function.description === 'string' && t.function.description.length >= 10,
      'description 过短或缺失（模型靠它选工具）：' + t.function.name
    );
    const p = t.function.parameters;
    assert.ok(p && p.type === 'object', 'parameters 必须是 object：' + t.function.name);
    assert.ok(p.properties && typeof p.properties === 'object', '缺少 properties：' + t.function.name);
  }
});

test('required 里声明的参数必须真实存在于 properties', () => {
  const bad = [];
  for (const t of TOOL_SCHEMAS) {
    const p = t.function.parameters || {};
    const req = Array.isArray(p.required) ? p.required : [];
    for (const r of req) {
      if (!p.properties || !Object.prototype.hasOwnProperty.call(p.properties, r)) {
        bad.push(t.function.name + '.' + r);
      }
    }
  }
  assert.deepEqual(bad, [], 'required 指向不存在的参数：' + bad.join('、'));
});

// 真实的 risk 词汇（由注册表实测得出，不是猜的）。
const ALLOWED_RISKS = new Set(['read', 'page', 'write', 'destructive', 'browser', 'network', 'external', 'high']);
// toolNeedsApproval（agent.js 的 risk → 审批类别映射）里被**显式**覆盖的取值；
// 其余落到默认类别 'commands' —— 源码注释自己也指出这「会静默错配」。
const EXPLICIT_CATEGORY_RISKS = new Set(['external', 'browser', 'network', 'write', 'destructive', 'page']);

test('risk 取值限定在已知词汇内，且与白名单完全一致', () => {
  for (const t of TOOL_REGISTRY) {
    assert.ok(ALLOWED_RISKS.has(t.risk), '未知 risk：' + t.name + ' → ' + t.risk);
  }
  const used = [...new Set(TOOL_REGISTRY.map((t) => t.risk))].sort();
  assert.deepEqual(used, [...ALLOWED_RISKS].sort(), '用到的 risk 与白名单不一致：' + used.join(','));
});

test('需要审批的工具，risk 必须被审批类别显式映射覆盖', () => {
  // 只有「需要审批且非逐次审批」的工具才会走到类别映射；
  // 若其 risk 不在显式映射里，就会静默落到默认类别 'commands'，
  // 表现为「关掉页面命令审批却把知识库写入一起放行了」这类错配。
  const bad = TOOL_REGISTRY.filter((t) => t.requiresApproval && !t.alwaysRequireApproval)
    .filter((t) => !EXPLICIT_CATEGORY_RISKS.has(t.risk))
    .map((t) => t.name + ' → ' + t.risk);
  assert.deepEqual(bad, [], '以下工具会静默落到默认审批类别：' + bad.join('、'));
});

test('只读工具不得要求审批（否则用户被无意义弹窗打断）', () => {
  for (const t of TOOL_REGISTRY) {
    if (t.readOnly) {
      assert.equal(t.requiresApproval, false, '只读工具不应要求审批：' + t.name);
      assert.equal(t.alwaysRequireApproval, false, '只读工具不应逐次审批：' + t.name);
    }
  }
});

test('「不改状态但需要审批」用 mutatesState 表达，不许硬塞进 readOnly', () => {
  // 这条守住两个字段的分工，否则下一个人会图省事给 fetch_webpage 标 readOnly，
  // 顺手把「联网抓取要用户批准」这道闸门一起拆掉（上面那条只读不变量会放它过去）。
  const fp = TOOL_REGISTRY.find((t) => t.name === 'fetch_webpage');
  assert.equal(fp.mutatesState, false, '抓网页不改任何页面/浏览器状态');
  assert.equal(fp.requiresApproval, true, '联网抓取必须保留审批 —— 它要花用户的钱');
  assert.equal(fp.readOnly, false, 'readOnly 在本仓库还隐含「不审批」，这里不能借它表达');
});

test('route 只能是 background 或 content', () => {
  for (const t of TOOL_REGISTRY) {
    assert.ok(['background', 'content'].includes(t.route), '非法 route：' + t.name + ' → ' + t.route);
  }
});

test('逐次审批的工具必须是高风险等级', () => {
  for (const t of TOOL_REGISTRY) {
    if (t.alwaysRequireApproval) {
      assert.equal(t.requiresApproval, true, 'alwaysRequireApproval 应蕴含 requiresApproval：' + t.name);
      assert.ok(t.risk === 'high' || t.risk === 'external', '逐次审批应标 high/external：' + t.name + ' → ' + t.risk);
    }
  }
});

test('没有工具停留在 unknown 风险（即元数据真的都生效了）', () => {
  const unknown = TOOL_REGISTRY.filter((t) => t.risk === 'unknown').map((t) => t.name);
  assert.deepEqual(unknown, [], '以下工具落到默认 unknown 风险：' + unknown.join('、'));
});

test('getToolMetadata 与注册表一致；外部 MCP 工具走独立分支', () => {
  for (const t of TOOL_REGISTRY) {
    assert.equal(getToolMetadata(t.name).risk, t.risk, t.name + ' 的 risk 查询不一致');
  }
  assert.equal(getToolMetadata('mcp__x__y').risk, 'external');
});

test('工具总数记录在案（当前远超项目自定目标 ≤25，属待偿还的技术债）', () => {
  // 这个断言不是「应该这么多」，而是让数量变化在 diff 里显式可见：
  // 每加一个工具都要在这里改数字，从而迫使作者面对工具膨胀的取舍。
  //
  // 44 —— C-4 合并：第 3 档（诊断）55→53，第 5 档（宏）53→51，
  //        第 4 档（知识库**只读**三件套）51→49，第 2 档（元素检查**只读**三件套）49→47，
  //        第 1 档（视觉标注四件套 → annotate({op})）47→44。
  //        三档合并都遵守同一条判据：**按执行路径与权限类别分组，而不是按语义相似度**。
  //        理由与不可做档见 docs/tool-merge-plan.md §8。
  // 45 —— 在 44 的基础上**新增**（不是合并）：`save_skill`。
  //        起因是会话 RF-FY6PUP 的真实能力缺口：用户说「沉淀为技能」，
  //        而技能族当时只有 `load_skill`（读手册）与 `install_skill`（从 SkillHub 装），
  //        没有任何工具能**写**一份技能 —— 模型只能降级成 macro(op=save) 去做，两头落空。
  //        风险等级取最高档（high + alwaysRequireApproval），理由见 tool-metadata.js 的条目注释。
  assert.equal(TOOL_REGISTRY.length, 45, '工具数量变化了：' + TOOL_REGISTRY.length + '（若有意新增/合并，请同步更新此断言与 docs/tool-merge-plan.md）');
});

// ---------------------------------------------------------------- prompt 体积预算
//
// 工具定义在**每一轮**都随请求发出，因此它的体积是持续成本，而不是一次性开销。
// 实测（用本仓库自己的 estimateTokens：CJK 按 1 token/字、非 CJK 按 1/4）：
//   全量 55 个约 10.0k tokens；browser_task 每轮下发 43 个约 8.3k tokens，
//   research_task 约 7.3k，chat_task 约 2.2k，knowledge_task 约 1.3k。
// 规模感：一个 30 轮的浏览器任务，仅工具定义就约 25 万 tokens 的请求体积
//（实际计费受服务端前缀缓存影响：工具块位于请求前缀且每轮不变，命中缓存时单价远低，
// 但首轮与缓存未命中要付全价）。
//
// 这里的预算不是「应该这么小」，而是让膨胀变成红灯：想加工具/加参数，
// 就得先面对这个数字并显式调高它。
//
// 2026-02 调整说明（C-4 第 1 档合并：视觉标注）：`browser_task` 由 33400 上调到 35600。
// 原因与第 3、5 档同源：四个标注工具的 schema 合成一个 `annotate`，
// 四段描述（highlight / outline / style / clear）必须都写进同一个工具定义里，
// 于是**工具数 -3、字符数 +1000 左右**。实测 34548 > 原预算 33400。
//
// 这已是**第三次**出现同一现象（诊断档 32791>32500、宏档 chat_task 8400→9700、本档 34548>33400）。
// 结论写在这里以免重复踩：**"工具数下降"≠"prompt 变小"**。
// 若后续还要合并，应当先精简描述（把四段说明压成一段 + 参数内注释），
// 而不是继续调高预算 —— 这个常量存在的意义就是让"调高"成为一个显式决定。
// 2026-02 调整说明（A3/A4/A5 轮：纠正"谁拦住了沙箱 eval"的归因）：
//   `run_javascript` / `handle_dialog` 各加了一句**正确性**说明 ——
//   拦住 eval 的是 MV3 扩展自身的 CSP（不是页面）；`promptText` 不传就会接受默认值。
//   两句都是"模型据此会做错事"的关键信息，不能为字节预算删掉 ✗
//   已先做一轮措辞精简（把 `run_javascript` 那段压到最短），仍差 123 字符 → 小幅上调 300。
//   ⚠ 这是"优先精简"原则下的**例外**；下次要再加时请继续精简，不要再靠调预算解决。
// 2026-02 新增 save_skill 一档的说明（44 → 45）：
//   本次**没有**调高任何预算，而是把这个新工具的 schema 描述压到 1459 字符
//   （初稿 1691，正好把「合计」顶到 39000 上限；按上面的原则先精简 --
//   压掉的是重复与客套，"以后怎么做 vs 本次日志"这类关键区分一字未动）。
//   结果：合计 38768 / 39000，只剩约 230 字符余量 —— 下一次新增工具**必须**先精简描述。
//   ⚠ 另有一条不体现在本表里的真实成本：`save_skill` 是 `alwaysAvailable`（跨意图常驻，
//   与 `load_skill` 同），因此它进「合计」但**不进**下面各意图的数字；
//   实际每轮下发的 prompt 比表里那几个数各多出这 1459 字符。这是既有设计
//   （见 lib/application/agent/mcp.js 的 alwaysAvailable 分支），这里如实记一笔，避免读者以为表=实际。
const SCHEMA_BYTES_BUDGET = {
  合计: 39000,
  browser_task: 35900,
  research_task: 28500,
  chat_task: 9700,
  knowledge_task: 5100,
};

test('工具定义体积不得超出预算（防 prompt 无声膨胀）', () => {
  const bytes = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');
  const total = bytes(BUILTIN_TOOLS);
  const report = ['全量 ' + total + ' 字符（预算 ' + SCHEMA_BYTES_BUDGET['合计'] + '）'];
  assert.ok(
    total <= SCHEMA_BYTES_BUDGET['合计'],
    '工具定义总量超出预算：' + report.join('；') + '。请精简描述，或有意识地调高预算。'
  );

  const byName = new Map(TOOL_REGISTRY.map((t) => [t.name, t]));
  for (const [intent, budget] of Object.entries(SCHEMA_BYTES_BUDGET)) {
    if (intent === '合计') continue;
    const info = resolveIntent(intent);
    const names = Array.isArray(info.allowedTools) ? info.allowedTools : [];
    const used = names.map((n) => byName.get(n)).filter(Boolean).map((t) => t.openai);
    const c = bytes(used);
    assert.ok(
      c <= budget,
      intent + ' 每轮下发的工具定义超出预算：' + c + ' > ' + budget + ' 字符（' + used.length + ' 个工具）'
    );
  }
});

test('每个意图下发的工具都必须真实存在（白名单不得指向已删/改名的工具）', () => {
  const known = new Set(TOOL_REGISTRY.map((t) => t.name));
  const bad = [];
  for (const intent of Object.values(INTENTS)) {
    const names = resolveIntent(intent).allowedTools || [];
    for (const n of names) {
      if (!known.has(n)) bad.push(intent + ' → ' + n);
    }
  }
  assert.deepEqual(bad, [], '意图白名单指向了不存在的工具：' + bad.join('、'));
});
