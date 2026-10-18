// inspect_element({ op }) 的合并边界与分派（C-4 第 2 档）。
//
// 为什么值得单独测：`op` 由**模型**填，而三个 op 会落到**三个不同的页面命令**。
// 分派写错（例如 op=table 落进 get_text）会让模型拿到一段普通文本却以为"表格提取失败" ——
// 静默给错数据，端到端也未必发现。
//
// 本档的**合并边界**同样重要：只合并了同权限、同执行路径的三个；
// get_attribute 与 get_element_source 必须**仍存在**（它们走各自不同的路径，
// 后者还被 MCP 的「页面元素 → 源码文件」闭环使用）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { TOOL_REGISTRY } from '../lib/assistant/tools.js';

const byName = Object.fromEntries(TOOL_REGISTRY.map((t) => [t.name, t]));

test('inspect_element 的 op 枚举覆盖三个原工具，外加 styles / options / query', () => {
  const op = byName.inspect_element.inputSchema.properties.op;
  // 前三项对应 C-4 合并的三个原工具（get_element_text / inspect_element / extract_table）。
  // 后两项都不是合并来的 —— 是做能力剧本时**补**的只读档：
  //   · `styles`：做「UI 美化」时发现"改完样式无法自证"（理由见 tests/read-styles.test.mjs）；
  //   · `options`：做「按属性挑选项」时发现**没有只读办法看下拉框有哪些选项** ——
  //     真模型探针实测只能借道 run_javascript（高危审批）。
  //     理由见 tests/read-options.test.mjs 与 commands.js 的 cmdReadOptions。
  assert.deepEqual(op.enum, ['inspect', 'text', 'table', 'styles', 'options', 'query']);
  assert.deepEqual(byName.inspect_element.inputSchema.required, ['op'], 'op 必填（缺了会静默走错分支）');
});

test('分派表必须与 lib/page/commands.js 的命令名一致（否则得到"页面命令无响应"）', async () => {
  // 这些命令名是内容脚本 switch 的 key；写错不会报错，只会让页面命令无响应。
  const cli = fs.readFileSync(new URL('../lib/page/commands.js', import.meta.url), 'utf8');
  for (const cmd of ['get_text', 'inspect_element', 'extract_table', 'read_styles', 'read_options', 'query_elements']) {
    assert.match(cli, new RegExp("case '" + cmd + "'"), '内容脚本应支持命令 ' + cmd);
  }
  // 直接断言**真实的分派表对象**，而不是在源码里做字符串切片 ——
  // C-1 拆分把 INSPECT_OPS 搬进 ./page-command-tools.js 时，
  // 基于切片的老写法会静默切到空串（然后断言失败但原因指向错误的地方）。
  const { INSPECT_OPS } = await import('../lib/assistant/page-command-tools.js');
  assert.deepEqual(INSPECT_OPS, {
    text: 'get_text',
    inspect: 'inspect_element',
    table: 'extract_table',
    styles: 'read_styles',
    options: 'read_options',
    query: 'query_elements',
  });
});

test('run_javascript 的选择点必须指向 query（而不是让模型自己写 querySelector）', () => {
  // 这段描述出现在模型**正要选择 run_javascript** 的那一刻；只写在系统提示里
  // 离决策更远。实测小红书会话里 35 次 run_javascript 大多是普通 DOM 查询。
  const desc = byName.run_javascript.description;
  assert.match(desc, /inspect_element\(\{op:"query"\}\)/, '要给出 query 档的准确调用形状');
  assert.match(desc, /找元素\/rect/, '要说清它替代的是哪类查询');
  assert.equal(byName.run_javascript.risk, 'page', 'run_javascript 已归入页面命令');
  assert.equal(byName.run_javascript.requiresApproval, true, '页面命令仍需要审批');
  assert.ok(!byName.run_javascript.alwaysRequireApproval, '不再单独占用逐次审批档');
});

test('跨框架查询/等待的 frameId 必须在 schema 里声明（技能文案已经这么用）', () => {
  // 技能正文写着 inspect_element({ op:"text", frameId: 5, ... }) 与
  // wait_for_element "同样支持 frameId"。执行层确实支持（frameIdFromArgs），
  // 但 schema 不声明时模型只能靠猜 —— 技能与工具契约就分叉了。
  for (const name of ['inspect_element', 'wait_for_element']) {
    const prop = byName[name].inputSchema.properties.frameId;
    assert.ok(prop, name + ' 必须声明 frameId');
    assert.equal(prop.type, 'integer');
    assert.match(prop.description, /iframe/, name + ' 的 frameId 说明要提到 iframe');
    assert.match(prop.description, /list_frames/, '要说明 frameId 的来源');
  }
});

test('被合并的两个工具名不得再出现在注册表里（否则模型会看到已失效的签名）', () => {
  assert.ok(!byName.get_element_text, 'get_element_text 应已并入 inspect_element');
  assert.ok(!byName.extract_table, 'extract_table 应已并入 inspect_element');
});

test('同档未合并的两个工具必须仍在（合并边界不得被顺手扩大）', () => {
  // 它们与另三个语义相似，但执行路径不同：
  //   get_attribute —— 走独立的 kbGetAttribute 消息
  //   get_element_source —— 走源码映射链路，被 MCP 的「元素 → 源码 file:line」闭环使用
  assert.ok(byName.get_attribute, 'get_attribute 执行路径不同，不应被合并');
  assert.ok(byName.get_element_source, 'get_element_source 被 MCP 闭环使用，不应被合并');
  assert.equal(byName.get_attribute.risk, 'read');
  assert.equal(byName.get_element_source.risk, 'read');
});

test('合并后权限不变：仍是 read + readOnly + parallelSafe', () => {
  // 三个原工具都是这一档；合并若把权限收紧（例如误继承 requiresApproval），
  // 会让每次元素检查都弹审批 —— 而它是最常用的读类动作之一。
  assert.equal(byName.inspect_element.risk, 'read');
  assert.equal(byName.inspect_element.readOnly, true);
  assert.equal(byName.inspect_element.requiresApproval, false);

  const md = fs.readFileSync(new URL('../lib/assistant/tool-metadata.js', import.meta.url), 'utf8');
  const line = md.split('\n').find((l) => l.trim().startsWith('inspect_element:'));
  assert.ok(line, '元数据里应有 inspect_element');
  assert.match(line, /parallelSafe: true/, '读类只读工具应保持可并行');
});

test('完成校验的证据名单必须认得合并后的名字', () => {
  // agent.js 的 EVIDENCE_READ_TOOLS 里原先写的是 get_element_text。
  // 改名后若不同步，「划出关键信息」这类任务的完成校验会重新丢掉文本证据
  //（那正是当初把 get_element_text 加进名单要修的问题）。
  const agent = fs.readFileSync(new URL('../lib/assistant/agent.js', import.meta.url), 'utf8');
  const block = agent.slice(agent.indexOf('const EVIDENCE_READ_TOOLS'), agent.indexOf('const EVIDENCE_READ_TOOLS') + 400);
  assert.match(block, /'inspect_element'/, '证据名单应包含 inspect_element');
  assert.ok(!/'get_element_text'/.test(block), '证据名单不得再引用已消失的 get_element_text');
});
