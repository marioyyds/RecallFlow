// 「读计算样式」（inspect_element 的 op=styles）的接线与防漂移门禁。
//
// 这一档是**做「UI 美化」能力时补出来的**，起因值得记下来：
//   `annotate({op:"style"})` 只回一句「已修改 N 个元素」—— 那证明的是"调用发出去了"，
//   不是"样式真的生效了"（取值可能非法被忽略，也可能被别处 !important 覆盖）。
//   而当时面板侧唯一的取证路径是 `run_javascript` 读 getComputedStyle，实测有两个硬伤：
//     ① 元数据 `alwaysRequireApproval` → **任何审批策略都拦不住地打断用户**；
//     ② 它经 eval 执行，**被页面 CSP 拦住会直接失败**（要另开 CDP 才落到主世界）。
//   而"读一下算出来的样式"本是彻头彻尾的只读操作。于是补 `op:"styles"`，
//   复用原本只给 MCP 侧 verify_change 用的 `readElementState` —— 不新增工具（仍 44 个）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { DEFAULT_STYLE_PROPS, formatStylesSummary } from '../lib/shared/utils.ts';
import { INSPECT_OPS } from '../lib/assistant/page-command-tools.ts';
import { TOOL_REGISTRY } from '../lib/assistant/tools.ts';

const cmdSrc = fs.readFileSync('lib/page/commands.ts', 'utf8');
const schemaSrc = fs.readFileSync('lib/assistant/tool-schemas.ts', 'utf8');

const inspectTool = () => TOOL_REGISTRY.find((t) => t.name === 'inspect_element');

// ---------------------------------------------------------------- 接线

test('op=styles 已接到内容脚本的 read_styles 命令上', () => {
  assert.equal(INSPECT_OPS.styles, 'read_styles', 'INSPECT_OPS 里必须有 styles → read_styles');
  assert.match(cmdSrc, /case 'read_styles': return cmdReadStyles\(params\)/, '派发表里必须有 read_styles 分支');
  // 签名里的类型标注是 TS 迁移（TITA-75）加的：允许 `params` 后面带可选标注，
  // 但函数名与参数名仍必须逐字对上 —— 这条门禁防的是"没有实现"，不是防类型。
  assert.match(cmdSrc, /function cmdReadStyles\(params(?::[^)]*)?\)/, '必须有 cmdReadStyles 实现');
});

test('cmdReadStyles 复用 readElementState，不另写一套取值逻辑', () => {
  // 复用是关键：readElementState 已被 MCP 侧的 verify_change 用了很久，
  // 自己再写一份 getComputedStyle 就有了第二个会漂移的真相来源。
  const at = cmdSrc.indexOf('function cmdReadStyles');
  const body = cmdSrc.slice(at, at + 1800);
  assert.match(body, /readElementState\(/, '应调用 readElementState');
  assert.ok(!/getComputedStyle/.test(body), '不应在 cmdReadStyles 里直接调 getComputedStyle');
});

test('schema 的 op 枚举与 INSPECT_OPS 完全一致（否则模型能传一个路由不认识的 op）', () => {
  const tool = inspectTool();
  assert.ok(tool, '应能找到 inspect_element');
  const enumVals = tool.inputSchema.properties.op.enum.slice().sort();
  const routed = Object.keys(INSPECT_OPS).slice().sort();
  assert.deepEqual(enumVals, routed, 'schema 声明的 op 必须与 INSPECT_OPS 的键一一对应');
  assert.ok(enumVals.includes('styles'), '枚举里必须有 styles');
});

test('op=styles 声明了 props 参数，且属于只读类别', () => {
  const tool = inspectTool();
  assert.ok(tool.inputSchema.properties.props, 'op=styles 需要 props 才能指定要读哪些属性');
  // 只读是这一档存在的理由：它不能被归到需要审批的类别里，
  // 否则"验证样式生效"又变回每次打断用户。
  assert.equal(tool.risk, 'read', 'inspect_element 必须是 read 风险级别');
  assert.equal(tool.readOnly, true, 'inspect_element 必须是只读');
});

// ---------------------------------------------------------------- 防漂移

test('**防漂移**：DEFAULT_STYLE_PROPS 的每一项都必须出现在 schema 说明里', () => {
  // 默认属性同时出现在两处：页面侧的实际读取（DEFAULT_STYLE_PROPS）与给模型的说明
  // （tool-schemas.js 是零 import 的纯数据模块，只能写字面量）。
  // 不钉住就会出现"文档说读了 A、实际读的是 B"——模型据此以为拿到了某个值，其实没读。
  const tool = inspectTool();
  const desc = String(tool.inputSchema.properties.props.description || '') + String(tool.description || '');
  const missing = DEFAULT_STYLE_PROPS.filter((p) => !desc.includes(p));
  assert.deepEqual(missing, [], 'schema 说明里缺少这些默认属性：' + missing.join(', '));
});

test('默认属性用连字符写法（readElementState 走 getPropertyValue，驼峰会取到空串）', () => {
  for (const p of DEFAULT_STYLE_PROPS) {
    assert.ok(!/[A-Z]/.test(p), '「' + p + '」应写成 CSS 连字符形式，不能是 JS 驼峰');
  }
  assert.ok(DEFAULT_STYLE_PROPS.includes('font-size'), '至少要包含 font-size');
});

// ---------------------------------------------------------------- 纯函数行为

test('formatStylesSummary：逐项列出，便于模型核对"改的值生效没有"', () => {
  const text = formatStylesSummary(
    [{ selector: '.wrap', visible: true, styles: { 'font-size': '17px', 'line-height': '28.9px' } }],
    1
  );
  assert.match(text, /命中 1 个/);
  assert.ok(text.includes('font-size=17px'), '应含 font-size=17px，实际：' + text);
  assert.ok(text.includes('line-height=28.9px'));
  assert.ok(text.includes('.wrap'));
});

test('formatStylesSummary：命中多于列出时说明截断；不可见元素要标注', () => {
  const text = formatStylesSummary([{ selector: '#a', visible: false, styles: { display: 'none' } }], 9);
  assert.match(text, /命中 9 个/, '应说明真实命中数');
  assert.match(text, /列出前 1 个/, '应说明只列出了一部分');
  assert.match(text, /不可见/, '不可见元素必须标注 —— 美化最怕的就是"靠隐藏达标"');
});

test('formatStylesSummary：空输入与缺字段不抛', () => {
  assert.match(formatStylesSummary([], 0), /（无）/);
  assert.match(formatStylesSummary(null, 0), /（无）/);
  const t = formatStylesSummary([{ selector: '.x' }], 1);
  assert.ok(t.includes('.x'), '缺 styles 时也要输出选择器');
});

test('这条门禁本身有牙齿：漏一个默认属性必须被发现', () => {
  const desc = DEFAULT_STYLE_PROPS.slice(0, -1).join(' / '); // 故意漏掉最后一项
  const missing = DEFAULT_STYLE_PROPS.filter((p) => !desc.includes(p));
  assert.deepEqual(missing, [DEFAULT_STYLE_PROPS[DEFAULT_STYLE_PROPS.length - 1]], '漏掉的那一项应被检出');
  assert.ok(!/[A-Z]/.test('font-size'), '连字符写法应通过');
  assert.ok(/[A-Z]/.test('fontSize'), '驼峰写法应被检出');
});
