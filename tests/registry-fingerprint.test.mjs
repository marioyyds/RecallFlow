// 工具注册表指纹门禁：为「搬运式重构」提供等价性证明。
//
// 背景：本仓库里 tools.js（2168 行）需要拆分，而作者此前做过同类搬运（tools.js 3027→2049 行），
// 当时的做法是**先固化注册表指纹（含完整 inputSchema 的 SHA-256），搬运后比对是否一致** ——
// 这是证明"只是搬家、没改行为"的最便宜也最可靠的手段。但那一次是手工做的、没有留下门禁。
//
// 本文把这件事变成常驻断言。它守住的是：
//   · 工具名集合不变；
//   · 每个工具的 inputSchema **逐字节**不变（描述、参数、required、enum 都算）；
//   · risk / requiresApproval / readOnly / route 等权限元数据不变。
// 于是"拆分 tools.js"这类改动一旦不小心改了对外契约，会立刻红灯 ——
// 而不是等到模型调用出错、或跑一次真实任务才发现。
//
// 唯一例外：**有意改动契约**时，需要同时更新本文件里的指纹并说明原因。
// 这不是"随便改改让它过"，而是强迫改动者显式确认"我确实改变了对外契约"。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { TOOL_REGISTRY } from '../lib/assistant/tools.js';

// 指纹覆盖：名字 + 完整 schema + 权限元数据。顺序无关（先按名字排序）。
function computeRegistryFingerprint(registry) {
  const canonical = registry
    .map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      risk: t.risk,
      requiresApproval: t.requiresApproval,
      readOnly: t.readOnly,
      alwaysAvailable: t.alwaysAvailable,
      alwaysRequireApproval: t.alwaysRequireApproval,
      route: t.route,
      timeoutMs: t.timeoutMs,
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
}

test('工具注册表指纹稳定（搬运式重构不得改变对外契约）', () => {
  const fp = computeRegistryFingerprint(TOOL_REGISTRY);
  // 作用不是"必须是某个魔数"，而是让**任何**对外契约变化都显式出现。
  //
  // 指纹变更历史（每次都必须写明原因）：
  //   df823e568f99f5e3 —— 基线。tools.js 五步搬运（net-parse / page-action-verify /
  //                       target-frame / tool-results）前后保持不变的证据。
  //   cab8453c034a6f74 —— **有意改动**：修正两处参数描述串台。
  //                       `save_macro.name` 原先被写成「可访问名（按钮文字 / aria-label），配合 role」，
  //                       而它其实是**宏的名字**（执行器把它用作 saveMacro 的 name，并回显 run_macro("<name>")）；
  //                       该工具也没有 role 参数。`load_skill.name` 同样被写成按钮可访问名，
  //                       而它是要加载的**技能名**。两处都会直接误导模型构造参数。
  //   c1e25a3575f7a834 —— **有意改动**：C-4 合并第 3 档（诊断）。
  //                       read_console + read_network + list_downloads → read_diagnostics(kind)，55 → 53。
  //                       三者原本权限完全一致（read/readOnly/parallelSafe），因此合并不改变任何权限语义。
  //   74fa51f522897891 —— **有意改动**：C-4 合并第 5 档（宏）。
  //                       save_macro + list_macros + run_macro → macro(op)，53 → 51。
  //                       **risk 取三者最高**：save_macro 是 write+审批 → macro 继承 write + 逐次审批。
  //                       ⚠ 另有两条**必须按 op 分别保留**的防线（见 lib/assistant/macros.js）：
  //                         · op=save 的写审批；· op=run 的执行期 REPLAYABLE_TOOLS 白名单
  //                          （曾有真实提权：run_macro 回放 run_javascript 绕过 alwaysRequireApproval）。
  //                       副作用：chat_task 原先只带最轻的 list_macros，现在必须带整个 macro schema，
  //                       该意图的 prompt 体积预算由 8400 上调到 9700（见 tests/registry.test.mjs 的说明）。
  //   7f87650e52112500 —— **有意改动**：C-4 合并第 4 档（知识库**只读**三件套）。
  //                       search_knowledge_base + list_knowledge_base + get_entry → knowledge_read(op)，51 → 49。
  //                       ⚠ **只合并了同权限类别的三个读工具**：add_entry（write）与 remove_entry（destructive）
  //                       刻意保持独立。原方案写的是"知识库 5→2"，但那需要把读与 destructive 合到一起，
  //                       而工具级审批**看不到 args**（见 lib/assistant/agent.js），
  //                       结果就是**每一次知识库检索都要批准** —— 那是全仓库最高频的知识库动作。
  //                       净减量与原方案相同（省 2 个），但不产生权限污染。理由详见 lib/assistant/knowledge.js。
  //   d92c7bddfc975d6b —— **有意改动**：C-4 合并第 2 档（元素检查**只读**三件套）。
  //                       get_element_text + inspect_element + extract_table → inspect_element({op})，49 → 47。
  //                       ⚠ **只合并了同权限、同执行路径**的三个：它们原本就共用一个 case
  //                       （都走 executePageTool → 内容脚本的 get_text / inspect_element / extract_table），
  //                       权限也完全一致（read/readOnly/parallelSafe）。
  //                       `get_attribute`（独立消息 kbGetAttribute）与 `get_element_source`
  //                       （源码映射链路，被 MCP 的「页面元素 → 源码文件」闭环直接使用）保持独立。
  //                       理由与第 4 档一致：**按执行路径与权限类别分组，而不是按语义相似度分组**。
  //   bd379daf4693655a —— **有意改动**：C-4 合并第 1 档（视觉标注四件套）。
  //                       highlight_text + outline_element + set_element_style + clear_page_overlays
  //                       → annotate({op})，47 → 44。
  //   d138640ba617ecfe —— **有意改动**：给 inspect_element 补 `op:"styles"`（读**计算后的**样式）。
  //                       **工具数不变（仍 44）** —— 这是给已有只读工具补一档，不是新增工具。
  //
  //                       起因：做「UI 美化」能力时发现**改完样式无法自证**。
  //                       `annotate({op:"style"})` 只回一句「已修改 N 个元素」，那证明的是
  //                       "调用发出去了"，不是"样式真的生效了"（可能被 !important 覆盖、
  //                       或因取值非法被忽略）。而在此之前面板侧唯一的取证路径是
  //                       `run_javascript` 读 getComputedStyle，它有**两个硬伤**（都实测到）：
  //                         ① 元数据是 `alwaysRequireApproval` → 任何审批策略都拦不住地打断用户；
  //                         ② 它经 eval 执行，**被页面 CSP 拦住会直接失败**（要另开 CDP 才能落到主世界）。
  //                       而"读一下算出来的样式"是彻头彻尾的**只读**操作 —— 它本该和
  //                       inspect/text/table 一起待在只读工具里，而不是借道一个高危工具。
  //
  //                       实现直接复用 `readElementState`（原本只给 MCP 侧 verify_change 用），
  //                       所以没有引入新的取值逻辑。副作用：`browser_task` 的 prompt 预算需相应上调，
  //                       见 tests/registry.test.mjs 的 SCHEMA_BYTES_BUDGET 说明。
  //                       四者风险完全相同（page + 逐次审批），且原本就共用同一条执行路径
  //                       （executePageTool → 内容脚本 highlight / outline / set_style / clear_highlights），
  //                       因此这是**纯粹的收敛**，不存在"取最高"或"路径不同"的歧义。
  //                       副作用：四个 schema 的描述合成一个，`browser_task` 的 prompt 预算
  //                       由 33400 上调到 35600（第三次出现"工具数下降但字符数上升"，
  //                       说明写在 tests/registry.test.mjs 的 SCHEMA_BYTES_BUDGET 上方）。
  const EXPECTED = 'd138640ba617ecfe';
  assert.equal(
    fp,
    EXPECTED,
    '注册表指纹变化了（当前 ' + fp + ' / 预期 ' + EXPECTED + '，工具数 ' + TOOL_REGISTRY.length + '）。' +
      '若是有意改动对外契约，请更新本文件的 EXPECTED 并说明原因；' +
      '若是搬运式重构（拆 tools.js 等），则说明改动**意外**改了契约，必须修回。'
  );
});

test('参数描述不得"串台"：声称配合 role 的工具必须真的有 role 参数', () => {
  // 这条门禁来自一次真实缺陷：`save_macro.name` 与 `load_skill.name` 的描述被从
  // click_element 复制过来，写成「可访问名（按钮文字 / aria-label），配合 role」——
  // 而这两个工具的 name 分别是「宏的名字」和「技能名」，且都没有 role 参数。
  // 描述是模型唯一的说明来源，写错会让它去构造一个不存在的参数含义。
  //
  // 检查规则（保守，只抓明确的自相矛盾）：
  //   若某参数的描述声称"配合 role"，则该工具**必须**声明 role 参数。
  const offenders = [];
  for (const tool of TOOL_REGISTRY) {
    const props = (tool.inputSchema && tool.inputSchema.properties) || {};
    const hasRole = Object.prototype.hasOwnProperty.call(props, 'role');
    for (const [pname, pdef] of Object.entries(props)) {
      const desc = String((pdef && pdef.description) || '');
      if (!desc) continue;
      if (/配合\s*role/.test(desc) && !hasRole) {
        offenders.push(tool.name + '.' + pname + ' 声称配合 role，但该工具没有 role 参数');
      }
    }
  }
  assert.deepEqual(offenders, [], '参数描述串台：\n  ' + offenders.join('\n  '));
});

test('参数描述不得把"定位用"的语义套到非定位参数上（枚举已知用例）', () => {
  // 上一条只能抓"声称配合 role"这一种形态。这里再明确钉住已修的具体缺陷，
  // 防止将来有人"顺手统一文案"时又改回去。
  // 注意：save_macro.name 在 C-4 第 5 档合并后成为 macro.name（同一个参数，换了工具名）——
  // 断言跟着**语义**走，而不是跟着已消失的工具名走。
  const byName = Object.fromEntries(TOOL_REGISTRY.map((t) => [t.name, t]));
  const macroName = byName.macro.inputSchema.properties.name.description;
  assert.match(macroName, /宏名|要起的宏名/, 'macro.name 是宏的名字，不是按钮可访问名');
  assert.ok(!/aria-label/.test(macroName), 'macro.name 的描述不得出现 aria-label');

  const loadSkillName = byName.load_skill.inputSchema.properties.name.description;
  assert.match(loadSkillName, /技能名/, 'load_skill.name 是要加载的技能名');
  assert.ok(!/aria-label/.test(loadSkillName), 'load_skill.name 的描述不得出现 aria-label');
});

test('指纹函数本身对契约变化敏感（否则它是一道假门禁）', () => {
  // 自我验证：若指纹函数对 schema/权限变化不敏感，上面的断言就形同虚设。
  const base = TOOL_REGISTRY.map((t) => Object.assign({}, t));
  const fp0 = computeRegistryFingerprint(base);

  const descChanged = base.map((t, i) => (i === 0 ? Object.assign({}, t, { description: t.description + 'x' }) : t));
  assert.notEqual(computeRegistryFingerprint(descChanged), fp0, '描述变化必须改变指纹');

  const schemaChanged = base.map((t, i) =>
    i === 0 ? Object.assign({}, t, { inputSchema: Object.assign({}, t.inputSchema, { required: ['__x'] }) }) : t
  );
  assert.notEqual(computeRegistryFingerprint(schemaChanged), fp0, 'schema 变化必须改变指纹');

  const riskChanged = base.map((t, i) => (i === 0 ? Object.assign({}, t, { risk: 'destructive' }) : t));
  assert.notEqual(computeRegistryFingerprint(riskChanged), fp0, '权限元数据变化必须改变指纹');

  // 顺序无关：重排不该改变指纹（否则每次搬运工具顺序都会假红）
  assert.equal(computeRegistryFingerprint(base.slice().reverse()), fp0, '顺序变化不应改变指纹');
});
