// 文档一致性门禁（C-4 方案）：保证 docs/tool-merge-plan.md 里的数字与注册表真实相符。
//
// 为什么需要它：这份方案的价值全在数字上（省几个、55→几、每档权限取谁）。
// 而仓库里已经出现过一次**手算错误**——§10 原先写"目标落在 ~28"，实际是 33。
// 手算的数字没人核，就会一直错下去，而且看起来完全正常。
// 这里把方案里的每一档**当成数据**声明一次，用注册表核对：
//   · 每个工具名真的存在；
//   · 净减量之和与文档声称的一致；
//   · 每档的权限"取最高"能被自动算出来（而不是靠人记）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { TOOL_REGISTRY } from '../lib/assistant/tools.ts';

const TOTAL = TOOL_REGISTRY.length; // 变更工具集时这里会自动跟随

// 与 docs/tool-merge-plan.md §2 的表一致。
// 改动方案时**两处一起改**，否则本门禁红灯 —— 这正是它存在的意义。
//
// `merged: true` 表示该档**已经执行**（方案文档里也标注了），此时 `from` 写的是合并后的现状。
const PLAN = [
  { id: 1, label: '视觉标注', from: ['annotate'], to: 1, kind: 'merge', merged: true },
  // 第 2 档**只合并了同权限、同执行路径的三个只读工具**（get_element_text / inspect_element /
  // extract_table → inspect_element({op})）：49 → 47。get_attribute（独立消息）与
  // get_element_source（源码映射链路，被 MCP 闭环使用）保持独立 —— 理由与知识库档一致。
  { id: 2, label: '元素检查（只读三件套）', from: ['inspect_element'], to: 1, kind: 'merge', merged: true },
  { id: 2.1, label: '元素检查（属性/源码）', from: ['get_attribute', 'get_element_source'], to: 2, kind: 'blocked' },
  { id: 3, label: '诊断', from: ['read_diagnostics'], to: 1, kind: 'merge', merged: true },
  // 第 4 档**只合并了同权限的读三件套**（search/list/get → knowledge_read）：
  // 51 → 49。add_entry（write）与 remove_entry（destructive）保持独立 ——
  // 原方案写"5→2"，但那需要把读与 destructive 合到一起，会让每次读取都被强制审批
  //（工具级审批看不到 args，见 lib/assistant/agent.js）。
  { id: 4, label: '知识库（只读三件套）', from: ['knowledge_read'], to: 1, kind: 'merge', merged: true },
  { id: 4.1, label: '知识库（写/删）', from: ['add_entry', 'remove_entry'], to: 2, kind: 'blocked' },
  { id: 5, label: '宏', from: ['macro'], to: 1, kind: 'merge', merged: true },
  // 技能族现在是**三个**工具：load_skill（read）/ install_skill（external）/
  // save_skill（high + alwaysRequireApproval，见 tool-metadata.js）。
  // 合并成 skill(op) 的结论**更不成立**了：继承最严的 save_skill 会让每次「加载技能手册」
  // 都变成逐次审批（高频、只读、安全的动作），而不继承就丢掉了保存技能正文的闸门。
  { id: 6, label: '技能', from: ['load_skill', 'install_skill', 'save_skill'], to: 1, kind: 'blocked' },
  { id: 7, label: '帧 + AX', from: ['list_frames', 'get_ax_snapshot'], to: 1, kind: 'blocked' },
  { id: 8, label: '指针族', from: ['click_element', 'click_at', 'hover_element', 'drag_element'], to: 1, kind: 'tradeoff' },
  { id: 9, label: '用户脚本', from: ['list_userscripts', 'search_userscripts', 'install_userscript', 'run_userscript'], to: 1, kind: 'tradeoff' },
];

const byName = Object.fromEntries(TOOL_REGISTRY.map((t) => [t.name, t]));

test('合并方案里每个工具名都真实存在（名字写错就没法执行）', () => {
  const bad = [];
  for (const g of PLAN) for (const n of g.from) if (!byName[n]) bad.push('第' + g.id + '档 ' + g.label + ' → ' + n);
  assert.deepEqual(bad, [], '方案引用了不存在的工具名：\n  ' + bad.join('\n  '));
});

test('方案的数字自洽：已合并的已生效，未做的按预估累计', () => {
  // 数字随执行进度变化，因此这里算的是**剩余可省**，并对已执行档单独记账。
  const ALREADY_SAVED = 2; // 第 3 档已执行：三个诊断工具 → 一个（55 → 53）
  const saveOf = (groups) =>
    groups.reduce((s, g) => s + (g.merged ? 0 : g.from.length - g.to), 0);

  const pendingMerges = PLAN.filter((g) => g.kind === 'merge' && !g.merged);
  const pendingAll = PLAN.filter((g) => !g.merged);
  const byId = (ids) => PLAN.filter((g) => ids.includes(g.id));
  // 现状：55 - 2（诊断）- 2（宏）- 2（知识库只读）- 2（元素检查只读）- 3（视觉标注）= 44，
  // 再 **+1**（本轮新增 `save_skill`，不是合并产物）= 45
  assert.equal(TOTAL, 45, '当前工具数应为 45（第 1、2、3、4、5 档已合并，另有新增的 save_skill）');

  // 可做档已全部执行完；剩下 8/9 两档属"需取舍"（指针族 / 用户脚本）
  assert.equal(TOTAL - saveOf(byId([8])), 42, '再做指针族应为 42');
  assert.equal(TOTAL - saveOf(byId([8, 9])), 39, '全部做完应为 39');
  // 所有"可重构"档已执行完（pendingMerges 应为空）。剩下的只有"需取舍"档 ——
  // 若将来又出现未执行的 merge 档，这里会失败，提醒同步方案与本文档。
  assert.deepEqual(pendingMerges.map((g) => g.label), [], '所有可重构档应已执行完；若有新增，请同步方案文档与下方数字');
  assert.ok(pendingAll.length > 0, '仍应有"需取舍"档留在 PLAN 里（若连它们也做完了，请更新本测试与方案文档）');

  // 关键断言：这条路**到不了** 28 —— 这是原先手算错误（声称 ~28）掩盖的事实。
  assert.ok(TOTAL - saveOf(pendingAll) > 28, '合并路径到不了 28；若将来能到，请更新方案与本文档说明');

  // 第 7 档（帧 + AX）不可做：get_ax_snapshot 需要 CDP，而 list_frames 刻意不依赖 CDP。
  // 合并会把一个本来能用的路径绑上 CDP 前置条件 —— 省 1 个工具不值得。
  // 这条断言把"为什么不做"钉住，避免将来有人照着表格直接合并。
  const ax = byName.get_ax_snapshot;
  const lf = byName.list_frames;
  assert.ok(ax && lf, '两个工具都应存在（若已被合并，请更新本断言与方案文档）');

  // 注意：断言必须落在**实现**上，不能落在 tools.js 的 dispatch case 上。
  // C-1 拆分后，三个页面读取工具共用一个 deps 对象（其中含 cdpAllowed），
  // 于是 dispatch case 里**必然**出现 `cdpAllowed` 字样 —— 扫 dispatch 会得出相反结论。
  // 本轮就踩过这个坑：切片还一度跨进相邻 case，读到邻居的代码。
  const readSrc = fs.readFileSync(new URL('../lib/assistant/page-read-tools.ts', import.meta.url), 'utf8');
  const fnBody = (name) => {
    const start = readSrc.indexOf('export async function ' + name + '(');
    if (start < 0) return '';
    const next = readSrc.indexOf('\nexport ', start + 10);
    return readSrc.slice(start, next < 0 ? undefined : next);
  };

  // list_frames 的实现**刻意不碰 CDP**（未开 CDP 的环境下也要能枚举框架）。
  const lfBody = fnBody('listFrames');
  assert.ok(lfBody, '应能在 page-read-tools.js 里找到 listFrames 实现');
  assert.ok(!/cdp/i.test(lfBody), 'list_frames 的实现不得依赖 CDP —— 合并会破坏这条路径');
  // listFramesRaw 同样不该碰 CDP（它用的是 chrome.scripting）。
  assert.ok(!/cdp/i.test(fnBody('listFramesRaw')), 'listFramesRaw 不得依赖 CDP');

  // get_ax_snapshot 则**依赖** CDP（它读的是可访问性树）。
  // 断言同样落在**实现**上（./code-access-tools.js），而不是 tools.js 的分派注册表 ——
  // C-1 完成后那里已没有 case，扫它只会切到空串（正是本轮踩过的坑）。
  const codeSrc = fs.readFileSync(new URL('../lib/assistant/code-access-tools.ts', import.meta.url), 'utf8');
  const axImpl = codeSrc.slice(codeSrc.indexOf('export async function getAxSnapshot('));
  assert.match(axImpl.slice(0, 400), /cdpAllowed/, 'get_ax_snapshot 的实现依赖 CDP（合并前必须知道这一点）');
});

test('每档的权限"取最高"可被自动算出（不靠人记）', () => {
  // 风险序：数值越大越严格。合并后的工具必须继承组内最大值。
  const ORDER = { read: 0, page: 1, browser: 1, network: 2, external: 2, write: 3, high: 4, destructive: 5 };
  const rank = (n) => {
    const t = byName[n];
    if (!t) return -1;
    return Math.max(ORDER[t.risk] === undefined ? 0 : ORDER[t.risk], t.requiresApproval ? 2 : 0, t.alwaysRequireApproval ? 4 : 0);
  };
  // 已合并的档写的是合并后的现状（如「宏」只剩 macro），因此单独给出它应继承的原成员。
  const ORIGINAL_MEMBERS = { 宏: ['save_macro', 'list_macros', 'run_macro'] };
  const rows = [];
  for (const g of PLAN) {
    if (g.merged) continue;
    const strongest = g.from.slice().sort((a, b) => rank(b) - rank(a))[0];
    rows.push(g.label + ' → 必须继承 ' + strongest + '（' + (byName[strongest] ? byName[strongest].risk : '?') + '）');
  }
  // 已合并档：用"原成员"核对它们的权限确实被继承了（不能只看合并后的一个名字）
  const mergedRows = [];
  for (const g of PLAN.filter((x) => x.merged)) {
    const members = ORIGINAL_MEMBERS[g.label] || g.from;
    const strongest = members.slice().sort((a, b) => rank(b) - rank(a))[0];
    mergedRows.push(g.label + ' → 必须继承 ' + strongest + '（' + (byName[strongest] ? byName[strongest].risk : '?') + '）');
  }
  // 三条最容易出错的继承关系，逐条钉住（用未被 blocked 的档）
  assert.match(rows.join('\n'), /技能 → 必须继承 save_skill（high）/, '技能合并必须继承 save_skill（现在族里最严的是它）');
  assert.match(rows.join('\n'), /用户脚本 → 必须继承 (install_userscript|run_userscript)（high）/, '用户脚本合并必须继承 high');
  // 第 4.1 档（知识库写/删）虽被判为 blocked，但它的"必须继承 destructive"依然要钉住 ——
  // 若将来有人真的把它合并了，这条断言会提醒他 add_entry 会变成 destructive。
  const kbWriteStrongest = ['add_entry', 'remove_entry'].sort((a, b) => rank(b) - rank(a))[0];
  assert.equal(kbWriteStrongest, 'remove_entry', '知识库写/删合并时必须继承 remove_entry 的 destructive');
  // 已合并的宏组：原成员里 save_macro 是 write+审批（最高），合并后是 macro。
  // 注意 ORIGINAL_MEMBERS 里的名字已不在注册表，因此这里改为**直接核对 macro 的权限**。
  assert.match(mergedRows.join('\n'), /宏 → 必须继承 save_macro（\?）/, '宏组原成员含 write，必须继承');
  const macroMeta = byName.macro;
  assert.ok(macroMeta, 'macro 工具应存在（宏组已合并）');
  assert.equal(macroMeta.risk, 'write', '宏合并后必须继承 write（原 save_macro 的等级）');
  assert.equal(macroMeta.requiresApproval, true, '宏合并后必须保留逐次审批');
  console.log('权限继承（未做）：\n  ' + rows.join('\n  '));
  console.log('权限继承（已合并）：\n  ' + mergedRows.join('\n  '));
});

test('宏合并必须保住"运行期白名单"这条防线（有真实提权先例）', () => {
  // run_macro 曾因执行期没有白名单而能回放 run_javascript，绕过 alwaysRequireApproval —— 等同提权。
  // 宏组合并成 macro(op) 后，这条防线**必须按 op=run 保留**：
  //   · op=save 要审批（写操作）
  //   · op=run 要过 REPLAYABLE_TOOLS 白名单（否则历史宏能执行任意工具）
  // 实现已移到 lib/assistant/macros.js —— 断言跟着实现走（否则一次纯搬运就让门禁失效）。
  const src = fs.readFileSync(new URL('../lib/assistant/macros.ts', import.meta.url), 'utf8');
  assert.match(src, /export const REPLAYABLE_TOOLS/, '回放白名单必须存在且被导出（tools.js 记录时也用它）');
  const runIdx = src.indexOf('export async function macroRun');
  assert.ok(runIdx > 0, 'macroRun 应存在');
  const runBody = src.slice(runIdx, runIdx + 1600);
  assert.match(runBody, /REPLAYABLE_TOOLS\.has/, 'op=run 执行期必须校验白名单（不能只靠 schema 声明）');
  // 记录时与回放时必须用**同一份**白名单：两处各写一份就会漂移，而漂移后果是
  // "回放能执行记录时不允许的工具"。tools.js 必须从 macros.js 导入它。
  const toolsSrc = fs.readFileSync(new URL('../lib/assistant/tools.ts', import.meta.url), 'utf8');
  assert.match(toolsSrc, /import \{[^}]*REPLAYABLE_TOOLS[^}]*\} from '\.\/macros\.(?:js|ts)'/, 'tools.js 必须从 macros.js 导入白名单（唯一来源）');
  assert.ok(!/const REPLAYABLE_TOOLS = new Set/.test(toolsSrc), 'tools.js 不得再自己声明一份白名单');
});

test('技能合并不可做：toolNeedsApproval 拿不到 args，无法按 op 分级审批', () => {
  // 第 6 档（load_skill + install_skill → skill(op)）看起来只差"按 op 分级审批"，
  // 但审批函数**没有 args 参数**，因此这个分级在当前架构下无法表达。
  // 合并后只能二选一：每次加载技能都要批准（高频安全操作变烦），
  // 或移除安装闸门（外部下载+写本地不再确认）。两者都比"省 1 个工具"更糟。
  // 这条断言把"为什么不做"钉住，避免将来有人照着表格直接合并。
  // 实现已搬到 lib/assistant/approval-policy.js —— 断言跟着实现走
  //（否则一次纯搬运就让门禁失效，而它守的是"审批函数拿不到 args"这个架构事实）。
  const policySrc = fs.readFileSync(new URL('../lib/assistant/approval-policy.ts', import.meta.url), 'utf8');
  const sig = policySrc.match(/export function toolNeedsApproval\(([^)]*)\)/);
  assert.ok(sig, 'toolNeedsApproval 应存在');
  assert.ok(
    !/\bargs\b/.test(sig[1]),
    'toolNeedsApproval 的签名里没有 args —— 若将来加了 args，本断言会失败，那时可以重新评估第 6 档'
  );
  // 两个工具的风险等级差异巨大，也说明合并不是"取最高"就完事
  const byName = Object.fromEntries(TOOL_REGISTRY.map((t) => [t.name, t]));
  assert.equal(byName.load_skill.risk, 'read', 'load_skill 是只读');
  assert.equal(byName.load_skill.alwaysAvailable, true, 'load_skill 常驻（每次对话都要能按需加载技能）');
  assert.equal(byName.install_skill.risk, 'external', 'install_skill 是外部来源');
  assert.equal(byName.install_skill.requiresApproval, true, 'install_skill 必须有安装闸门');
});

test('方案文档存在且写明了"到不了 28"这个事实', async () => {
  const fs = await import('node:fs');
  const doc = fs.readFileSync(new URL('../docs/tool-merge-plan.md', import.meta.url), 'utf8');
  assert.match(doc, /55 → 33/, '文档必须写出真实落点');
  assert.match(doc, /到不了 28|要到 28/, '文档必须写明差距，而不是沿用旧的 ~28 说法');
  assert.match(doc, /权限取最高|取最高/, '文档必须写明权限继承约束');
  assert.match(doc, /已经存下来的宏|存量数据|旧宏/, '文档必须提示存量宏引用旧工具名的兼容问题');
});
