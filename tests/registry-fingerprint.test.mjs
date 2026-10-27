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

import { TOOL_REGISTRY } from '../lib/assistant/tools.ts';

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
      // 「会不会改动状态」的独立声明（readOnly 之外还有 mutatesState:false 这一路）——
      // 不进指纹的话，把 fetch_webpage 的 mutatesState 删掉也不会有任何红灯。
      mutatesState: t.mutatesState,
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
  //   7d87402108e3a570 —— **有意改动**：修掉「滚动内部可滚动容器」的能力缺口。
  //                       **工具数不变（仍 44）**，只改 `scroll_page` 的 `y`/`x` 两处参数说明。
  //
  //                       起因：做「虚拟列表」能力时发现**没有任何一等公民的滚法能滚内部容器**。
  //                       原先：有目标 → `scrollIntoView`（对已在视口里的容器是空操作，`y` 被忽略）；
  //                       无目标 → `window.scrollBy`（**只动窗口**）。虚拟列表、带 overflow 的面板
  //                       全是内部容器，于是只能反复把可见行 scrollIntoView 慢慢推，
  //                       或 run_javascript 自己设 scrollTop（一次高危审批，还丢掉滚动结果回报）。
  //
  //                       现在 `scroll_page({ selector, y })` = "把该元素自身滚动 y 像素"，
  //                       并在结果里回报**实际落点**（scrollTop=… / 位置没变时说明原因）。
  //                       旧说明「有 ref/selector/text/top/left 时忽略」与实现相反、也正是否认了这个能力，
  //                       一并改成"与 ref/selector/text 同用时滚该元素自身，否则滚窗口"。
  //
  //                       ⚠ 两处说明都**刻意压到与原串等长**：它是每轮下发的工具定义，
  //                       膨胀会被 tests/registry.test.mjs 的体积预算拦下（本次初稿超了 90 字符，已收紧）。
  //   281f58be3495237a —— **有意改动**：给 `inspect_element` 补 `op:"options"`（读 `<select>` 的选项清单）。
  //                       **工具数不变（仍 44）**，与 `op:"styles"` 同属"给已有只读工具补一档"。
  //
  //                       起因（真模型探针实测，不是推测）：任务「选最便宜的那个配送方式」下，
  //                       模型**只能先写一段 JS**：
  //                         run_javascript({ code:"Array.from(document.querySelector('#ship').options)…" })
  //                       因为闭合的 `<select>` 里 `<option>` **没有布局盒子**，正文抽取按"不可见"跳过 ——
  //                       `get_page_snapshot` 的正文里看不到选项文案（价格常常只写在选项里）；
  //                       而 `get_attribute` 只读**属性**，读不了 `outerHTML`。
  //                       代价：一次 `alwaysRequireApproval` 的高危审批（CSP 严的页面还会直接失败）。
  //
  //                       与前两次同一条判据：**只读的事就该由只读工具做**，不该借道高危工具。
  //                       ⚠ 本次**没有**上调体积预算：先压缩了 `op` 那段说明把字符数压回预算内
  //                       （该常量上方写着"应当先精简描述，而不是继续调高预算"）。
  //   ── A3/A4/A5 轮（CDP 超时与归因纠正）────────────────────────────────────────
  //   内容：`run_javascript` 的描述与 `engine` 参数说明**纠正归因** ——
  //        拦住沙箱 eval 的是 **MV3 扩展自身的 CSP**，不是页面的（实测在完全没有 CSP
  //        的夹具页上同样被拒，错误里那条 directive 是扩展的）。
  //        旧说法（"受页面 CSP 约束 / 多数站点的 CSP 会禁止"）会把人引向
  //        "换个页面试试"，也让人以为关掉 CDP 还能做简单读取 ✗
  //        同轮 `handle_dialog` 也补了两句：**不要重复点击**触发按钮、
  //        `promptText` 不传就接受默认值（目标值与默认值不同时必须传）。
  //   判据：这些是**对外契约的正向改动**（模型据此才知道要开 CDP、要回填值），不是表述调整。
  //   ⚠ 本轮先精简措辞、仍差 123 字符，故 `SCHEMA_BYTES_BUDGET.browser_task` 上调 300
  //      （见 tests/registry.test.mjs 的说明：那是"优先精简"原则下的一次例外）。
  //   58a68187a828f71f —— **有意改动**：打开视觉开关（`VISION_ENABLED` false → true）。
  //                       **工具数不变（仍 44）**，唯一变化是 `take_screenshot` 的 description：
  //                       整句从「图片**只展示给用户与留档**，不进入你的上下文 —— 当前模型是纯文本的，
  //                       **你看不到图像内容**…」换成「图片也会随请求送进你的上下文（只送预算内的最近几张，
  //                       超出的会省略并说明）—— 你可以据此观察页面外观。」
  //
  //                       为什么算**契约**改动：工具描述是模型唯一的说明来源，它现在明确授予了
  //                       "可以据截图观察外观"这一能力（此前明确否认）。这也正是本门禁存在的意义 ——
  //                       开关翻转**必然**改变模型看到的内容，所以它必须在这里显式留痕。
  //                       验证"唯一变化就是这一处"的方式（可复现，本轮实跑）：
  //                         ① 从 `git archive HEAD` 解出旧树，分别算两边指纹 ⇒ 旧 = fb63cc85d45590b1（与本文件原基线一致）；
  //                         ② 逐工具比对 name/description/inputSchema/risk/… ⇒ 差异条目**恰好 1 条**：
  //                            `take_screenshot：description 变了`（44 → 44 个工具，权限元数据全等）。
  //                       ⚠ 文案的两档都在 `lib/shared/utils.js`（`VISION_UNAVAILABLE_TOOL_COPY` /
  //                       `VISION_ENABLED_TOOL_COPY`），关闭臂逐字节原文由
  //                       tests/vision-text-conditional.test.mjs 的 ① 钉住 —— 关回去会得到原指纹。
  //   972b98d1b7c0f3d6 —— **有意改动**：同一轮内的**文案如实化**（仍在 `take_screenshot` 这一条上）。
  //                       开启侧原稿写「只送**预算内**的最近几张，超出的会省略并说明」，
  //                       但人读 + 脚本核对发现接线**没有**做这件事：`agent.js` 是**每张截图各调用一次**
  //                       `visionMessagesFor([res.screenshot])` ⇒ 每次只看到 1 张，`maxImages: 2`
  //                       永远不是约束（实测 5 次各传 1 张 ⇒ 5 张全进上下文、0 次"省略说明"）。
  //                       ⇒ 换成如实的「本次任务里截的每张都会送；单张过大的会省略并说明」，
  //                       并让"单张过大"这条路**真的会说明**（原先全被跳过时连说明一起丢掉 = 静默丢图 ✗，
  //                       已在 `vision.js` 的 `visionMessagesFor` 修掉）。工具数仍 44，权限元数据不变。
  //                       ⚠ 这两处（文案 + 说明修复）同样属于"改了模型可见内容"⇒ 同样需要测量，
  //                       而本轮环境无密钥 ⇒ 未测量（如实记录在 docs/real-model-eval-log.md 第六轮）。
  //   2cfd7d9f6eea088c —— **有意改动**：新增 `save_skill`（技能族第一个**写**工具），44 → 45。
  //                       起因是会话 RF-FY6PUP 的能力缺口：用户说「沉淀为技能」，
  //                       而技能族只有 load_skill（读）与 install_skill（从 SkillHub 装）——
  //                       没有工具能写一份技能，模型只能拿 macro(op=save) 去顶，最后两头落空
  //                       （用户看到的就是「不能保存 skill 和宏」）。
  //                       风险取最严一档：`high` + `alwaysRequireApproval`
  //                       （技能正文会进入今后的系统提示 ⇒ 这是一条**持久化**的注入面，
  //                       比单次 run_javascript 影响更长远）。理由与残余风险见 tool-metadata.js。
  //                       `alwaysAvailable: true` 是必需的：实测该请求被判成 knowledge_task，
  //                       而知识库意图只带 6 个工具 —— 不常驻就永远看不到这个能力。
  //   e02d8c26ddfdc419 —— **有意改动**：add_entry 增加可选 `id`。
  //                       目的：把“整理会话到知识库”重复执行时能更新同一篇文档，
  //                       而不是每次生成新 id、留下多份重复记录。权限类别不变。
  //   a3ef45244f8a4e8a —— **有意改动**：`type_text` 描述补上输入契约 ——
  //                       输入后回读；富文本/多行自动降级；不一致返回 ok:false（partial:true）。
  //                       这改变了模型看到的工具语义（不能再把“已派发”当“已写入”），
  //                       工具数仍 45，权限元数据不变。
  //   491b38bf743499f6 —— **有意改动**：`inspect_element` 增加 `op:"query"`（结构化候选查询，
  //                       返回 ref/rect/customElement/shadowDepth），并精简原描述以守住体积预算。
  //                       这是新增只读查询入口，工具数仍 45，权限元数据不变。
  //   ee47a65b601eab20 —— **有意改动**：`run_javascript` 的描述补上"找元素/rect 用
  //                       inspect_element({op:"query"})"。改的是**工具选择点**的引导：
  //                       模型准备写 querySelector 时看到的正是这段描述，而系统提示里的
  //                       同类规则离这个决策更远。工具数仍 45，权限元数据不变。
  //   4bb18dc10068e1fd —— **有意改动**：`inspect_element` / `wait_for_element` 声明
  //                       `frameId`。执行层一直支持（frameIdFromArgs），技能正文也一直
  //                       这么写，但 schema 没声明 —— 模型只能猜。工具数仍 45，
  //                       权限元数据不变；体积仍在预算内（35269 / 35900）。
  //   0fe0af8aed91bfb9 —— **有意改动**：`run_javascript` 从 high + alwaysRequireApproval
  //                       移到 risk:'page'，由「页面命令」类别统一审批，不再单独设置。
  //                       工具数仍 45；这是用户明确要求的权限归类变化。
  //   b403f817a09653ac —— **有意改动**：`run_javascript` 的工具描述同步为「页面命令审批」，
  //                       不再声称"每次执行都需用户批准"（模型可见文案必须与新元数据一致）。
  //   0a725fcc26c129f9 —— **有意改动**：`switch_tab` / `open_tab` 的描述补上标签页克制规则。
  //                       原因：用户实测模型会为“验证一下”反复 A→B→A，页面持续闪动。
  //                       现在 schema 直接告诉模型：优先当前页、同一 tab 是 no-op、
  //                       达到上限会被拒绝、已在前台的复用页不会再次激活。
  //                       工具数与权限元数据均未变化。
  //   b24e444910f87bfc —— **有意改动**：新增元数据字段 `mutatesState`，并给 `fetch_webpage` 标上 false。
  //                       要解决的问题：完成校验要按任务性质选判据（agent.js 的 classifyTaskKind），
  //                       而它原先只看 `readOnly`。`fetch_webpage` 不改任何状态，所以在研究类任务里
  //                       整个 run 被当成「页面写操作」，去问「页面按要求变了吗」—— 研究类任务在长页面上
  //                       永远答不出这个问题，于是被判未达成、白烧几轮校验。
  //                       为什么不直接给 `fetch_webpage` 标 readOnly：本仓库的 readOnly 是**复合承诺**
  //                       （不改状态 **且** 不需要审批），registry.test.mjs 明确守住了它；
  //                       而联网抓取必须保留审批。于是把两件事拆成两个字段，readOnly 语义不变。
  //                       工具数与审批行为均未变化；`mutatesState` 已纳入本指纹的覆盖范围。
  const EXPECTED = 'b24e444910f87bfc';
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
