// 桥接契约门禁：MCP server 调用的方法名 必须与 扩展 relay 支持的方法名 一致。
//
// 为什么需要：这条链路（真实浏览器会话、页面健康、截图）横跨两个包，
// 且**最难手工回归** —— 方法名拼错/改名只会在运行时表现为 "unknown method"，
// 而那时用户已经在等结果了。这里在提交前就把它变成红灯。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  BRIDGE_METHODS,
  BROWSER_ACTION_METHODS,
  DANGEROUS_BACKGROUND_METHODS,
  DANGEROUS_CONTENT_METHODS,
  DANGEROUS_METHODS,
  EXCLUDED_AGENT_LOOP_METHODS,
  EXTENSION_METHODS,
  PAGE_ACTION_BACKGROUND_METHODS,
  PAGE_ACTION_CONTENT_METHODS,
  READONLY_BACKGROUND_METHODS,
  READONLY_CONTENT_METHODS,
  isBridgeMethod,
  isExtensionMethod,
} from '../lib/shared/bridge-methods.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const MCP_INDEX = path.join(ROOT, 'integrations/opencode/recallflow-mcp/index.js');
const RELAY = path.join(ROOT, 'lib/bridge/relay.js');

const mcpSource = fs.readFileSync(MCP_INDEX, 'utf8');
const relaySource = fs.readFileSync(RELAY, 'utf8');

/** 抽出 MCP server 里所有 callExtension('x', ...) 的方法名。 */
function mcpCalledMethods(src) {
  const out = new Set();
  const re = /callExtension\(\s*'([a-z_]+)'/g;
  let m;
  while ((m = re.exec(src))) out.add(m[1]);
  return out;
}

/** 抽出 relay 的 dispatch 里出现的 method === 'x' 分支名。 */
function relayDispatchedMethods(src) {
  const out = new Set();
  const re = /method === '([a-z_]+)'/g;
  let m;
  while ((m = re.exec(src))) out.add(m[1]);
  return out;
}

test('方法清单非空且唯一', () => {
  assert.ok(BRIDGE_METHODS.length > 0);
  assert.equal(new Set(BRIDGE_METHODS).size, BRIDGE_METHODS.length, '清单里有重复方法名');
  for (const m of BRIDGE_METHODS) assert.match(m, /^[a-z][a-z0-9_]*$/, '方法名不合规范：' + m);
});

test('MCP server 调用的每个方法都在清单里（否则运行时报 unknown method）', () => {
  const called = [...mcpCalledMethods(mcpSource)];
  assert.ok(called.length > 0, '未能从 MCP server 解析出任何 callExtension 调用（解析器需更新？）');
  const unknown = called.filter((m) => !isBridgeMethod(m));
  assert.deepEqual(unknown, [], 'MCP 调用了扩展不认识的方法：' + unknown.join('、'));
});

test('清单里的每个方法都必须存在于 MCP 调用侧（清单不得有僵尸条目）', () => {
  const called = mcpCalledMethods(mcpSource);
  const unused = BRIDGE_METHODS.filter((m) => !called.has(m));
  assert.deepEqual(unused, [], '清单里有方法从未被 MCP 调用（改名前忘了清理？）：' + unused.join('、'));
});

test('清单里的每个方法都必须有 relay dispatch 分支（否则清单是空头支票）', () => {
  const dispatched = relayDispatchedMethods(relaySource);
  const missing = BRIDGE_METHODS.filter((m) => !dispatched.has(m));
  assert.deepEqual(missing, [], '清单里有方法却没有 dispatch 分支：' + missing.join('、'));
});

test('relay 的每个 dispatch 分支都必须登记在清单里（否则文档/契约滞后）', () => {
  const dispatched = [...relayDispatchedMethods(relaySource)];
  const undeclared = dispatched.filter((m) => !isBridgeMethod(m));
  assert.deepEqual(undeclared, [], 'relay 有分支但未登记到 BRIDGE_METHODS：' + undeclared.join('、'));
});

// ---- 插件档位（只读档 + 改页面档）的清单 ↔ 分发一致性 ----
//
// 上面那条"每个方法都要有 dispatch 分支"的正则只认 `method === 'x'` 字面分支，
// 而这些档位走的是**查表分发**（`XXX_METHODS.includes(method)`）—— 看不见。
// 所以这里补一组对称检查，否则"把方法加进清单、忘了让 dispatch 查那张表"
// 会静默变成运行时的 unknown method（而这条链路最难手工回归）。
const TIER_LISTS = [
  ['READONLY_CONTENT_METHODS', READONLY_CONTENT_METHODS],
  ['READONLY_BACKGROUND_METHODS', READONLY_BACKGROUND_METHODS],
  ['PAGE_ACTION_CONTENT_METHODS', PAGE_ACTION_CONTENT_METHODS],
  ['PAGE_ACTION_BACKGROUND_METHODS', PAGE_ACTION_BACKGROUND_METHODS],
  ['BROWSER_ACTION_METHODS', BROWSER_ACTION_METHODS],
  ['DANGEROUS_CONTENT_METHODS', DANGEROUS_CONTENT_METHODS],
  ['DANGEROUS_BACKGROUND_METHODS', DANGEROUS_BACKGROUND_METHODS],
];

/** 从插件源码里解析某个 `const NAME = [ … ];` 清单里的方法名。 */
function pluginList(src, name) {
  const m = src.match(new RegExp('const ' + name + ' = \\[([\\s\\S]*?)\\];'));
  assert.ok(m, '应能从插件源码解析出 ' + name + ' 数组');
  return [...m[1].matchAll(/'([a-z][a-z0-9_]*)'/g)].map((x) => x[1]);
}

test('档位清单：互不重叠、不与 BRIDGE_METHODS 重叠，合起来正好是 EXTENSION_METHODS', () => {
  const seen = new Map();
  for (const [label, list] of TIER_LISTS) {
    for (const m of list) {
      assert.ok(!seen.has(m), '方法 ' + m + ' 同时出现在 ' + seen.get(m) + ' 与 ' + label + '（归类必须唯一）');
      seen.set(m, label);
      assert.ok(!isBridgeMethod(m), '档位方法不该出现在 BRIDGE_METHODS（那是 MCP 的清单）：' + m);
    }
  }
  const extra = EXTENSION_METHODS.filter((m) => !isBridgeMethod(m) && !seen.has(m));
  assert.deepEqual(extra, [], 'EXTENSION_METHODS 里有既不属于 MCP 也不属于任何档位的方法：' + extra.join('、'));
  // 反向：每个档位方法都必须出现在 EXTENSION_METHODS 里
  const missing = [...seen.keys()].filter((m) => !isExtensionMethod(m));
  assert.deepEqual(missing, [], '档位清单里有方法没进 EXTENSION_METHODS：' + missing.join('、'));
});

test('档位清单：dispatch 必须真的查每一张表，且不许为它们写字面分支', () => {
  for (const [label, list] of TIER_LISTS) {
    assert.ok(
      relaySource.includes(label + '.includes(method)'),
      'dispatch 必须查 ' + label + ' —— 加了清单却没让 dispatch 查表 = 运行时报 unknown method'
    );
    // 字面分支会把"路由"知识藏进代码里，而且躲不过上面那条"清单 ↔ 分支"的检查
    for (const m of list) {
      assert.ok(
        !relaySource.includes("method === '" + m + "'"),
        '不要为档位方法写字面分支（' + m + '）—— 走清单查表，路由信息留在数据里'
      );
    }
  }
});

// 三档受审批门禁。这是**安全边界**，所以要单独钉住三件事：
// ① 每一档都不能进 probe-tool 的白名单（BRIDGE_METHODS）；
// ② 插件必须为每一档做 config 门禁，且默认（未显式开启）即拒绝；
// ③ 拒绝信息里必须写清"怎么开"。
test('受控档位：探针白名单不能触发它们，且插件必须逐档做 config 门禁（默认拒绝）', () => {
  const gated = [
    ...PAGE_ACTION_CONTENT_METHODS,
    ...PAGE_ACTION_BACKGROUND_METHODS,
    ...BROWSER_ACTION_METHODS,
    ...DANGEROUS_METHODS,
  ];
  for (const m of gated) {
    assert.ok(!BRIDGE_METHODS.includes(m), '受控方法 ' + m + ' 不该在 probe-tool 的白名单里');
  }
  const pluginSrc = fs.readFileSync(path.join(ROOT, 'integrations/dsh-plugin-recallflow-one/index.js'), 'utf8');

  // 清单两端必须一致（任一侧改了而另一侧没改就红）
  assert.deepEqual(
    pluginList(pluginSrc, 'PAGE_ACTION_METHODS').sort(),
    [...PAGE_ACTION_CONTENT_METHODS, ...PAGE_ACTION_BACKGROUND_METHODS].sort(),
    '插件的改页面档清单必须与共享清单一致'
  );
  assert.deepEqual(
    pluginList(pluginSrc, 'BROWSER_ACTION_METHODS').sort(),
    BROWSER_ACTION_METHODS.slice().sort(),
    '插件的浏览器/网络档清单必须与共享清单一致'
  );
  assert.deepEqual(
    pluginList(pluginSrc, 'DANGEROUS_METHODS').sort(),
    DANGEROUS_METHODS.slice().sort(),
    '插件的危险档清单必须与共享清单一致'
  );

  // 门禁机制本身：一张表 + 三个开关，且默认（config 里没这个键）即拒绝
  assert.match(
    pluginSrc,
    /if \(gate\.list\.includes\(method\) && config\[gate\.key\] !== true\)/,
    '插件必须用统一门禁表逐档检查，且默认（未显式开启）即拒绝'
  );
  for (const key of ['allowPageActions', 'allowBrowserActions', 'allowDangerousActions']) {
    assert.ok(pluginSrc.includes("key: '" + key + "'"), '门禁表里应有 ' + key + ' 这一档');
    assert.ok(pluginSrc.includes(key), '拒绝信息里要提到 ' + key + '（否则用户不知道开哪个）');
  }
  assert.ok(pluginSrc.includes('然后重启 DSH'), '拒绝信息要说明改完还需重启 DSH');
});

// 刻意不接入的那 4 个（面板 agent 自己的循环/UI 控制）必须真的没被接进来 ——
// 否则会长出"两套计划状态互相打架"这种问题。
test('刻意排除：面板 agent 的循环/UI 控制工具不得出现在任何清单或插件方法表里', () => {
  const pluginSrc = fs.readFileSync(path.join(ROOT, 'integrations/dsh-plugin-recallflow-one/index.js'), 'utf8');
  for (const m of EXCLUDED_AGENT_LOOP_METHODS) {
    assert.ok(!isExtensionMethod(m), '被排除的方法 ' + m + ' 不该出现在 EXTENSION_METHODS 里');
    for (const name of ['BROWSER_METHODS', 'PAGE_ACTION_METHODS', 'BROWSER_ACTION_METHODS', 'DANGEROUS_METHODS']) {
      assert.ok(!pluginList(pluginSrc, name).includes(m), '被排除的方法 ' + m + ' 不该出现在插件的 ' + name + ' 里');
    }
  }
  assert.ok(
    /EXCLUDED_AGENT_LOOP_METHODS/.test(fs.readFileSync(path.join(ROOT, 'lib/shared/bridge-methods.js'), 'utf8')),
    '排除要有明确记录（导出的清单 + 注释说明为什么），不能靠"忘了"'
  );
});

test('插件的方法表不许声称扩展做不到的方法（含拼写错），且档位方法必须都暴露给插件', () => {
  const pluginSrc = fs.readFileSync(path.join(ROOT, 'integrations/dsh-plugin-recallflow-one/index.js'), 'utf8');
  const m = pluginSrc.match(/const BROWSER_METHODS = \[([\s\S]*?)\];/);
  assert.ok(m, '应能从插件源码解析出 BROWSER_METHODS 数组');
  const methods = [...m[1].matchAll(/'([a-z][a-z0-9_]*)'/g)].map((x) => x[1]);
  assert.ok(methods.length >= 10, '解析出的方法数太少，正则可能已失效：' + methods.length);
  assert.equal(new Set(methods).size, methods.length, '插件方法表里有重复项');

  const unknown = methods.filter((x) => !isExtensionMethod(x));
  assert.deepEqual(
    unknown,
    [],
    '插件声称支持、但扩展 dispatch 做不到的方法（拼错即属于此类）：' + unknown.join('、')
  );

  const missingInPlugin = [...READONLY_CONTENT_METHODS, ...READONLY_BACKGROUND_METHODS].filter(
    (x) => !methods.includes(x)
  );
  assert.deepEqual(missingInPlugin, [], '只读档清单里有方法没暴露给插件：' + missingInPlugin.join('、'));
});

test('截图链路两端对齐（relay 实现 + MCP 工具 + 归档函数都存在）', () => {
  assert.ok(isBridgeMethod('screenshot_capture'), 'screenshot_capture 应在清单里');
  assert.ok(/async function screenshotCapture\(/.test(relaySource), 'relay 应实现 screenshotCapture');
  assert.ok(/name: 'page_screenshot'/.test(mcpSource), 'MCP 应暴露 page_screenshot 工具');
  assert.ok(/async function pageScreenshot\(/.test(mcpSource), 'MCP 应实现 pageScreenshot');
  // 断言要抓的是**语义**：page_screenshot 的结果必须直接返回，
  // 不能掉进「JSON.stringify(result)」那条通用包装 —— 否则图片会变成一坨文本而静默失效。
  // （早先这里用单行 return 的正则，为发事件改成多行块后就误报了；定长窗口不会因换行/缩进而失效。）
  const shotAt = mcpSource.indexOf("else if (name === 'page_screenshot')");
  assert.ok(shotAt >= 0, '应存在 page_screenshot 的独立分支');
  const shotWindow = mcpSource.slice(shotAt, shotAt + 300);
  assert.ok(/\breturn\b/.test(shotWindow), 'page_screenshot 分支必须直接 return：' + shotWindow.slice(0, 160));
  assert.ok(
    !/JSON\.stringify\(/.test(shotWindow),
    'page_screenshot 分支不得把结果 JSON 化（图片必须是 image 内容块）：' + shotWindow.slice(0, 160)
  );
  const store = fs.readFileSync(path.join(ROOT, 'lib/shared/evidence-store.js'), 'utf8');
  assert.ok(/export function archiveImage\(/.test(store), 'evidence-store 应提供 archiveImage');
});

test('面板事件链路已整体移除（服务端成形 + 扩展转发 + 面板渲染三者都不在了）', () => {
  // 这条链路曾跨越三个包，现在整条消失：生产者（DSH hook 经 /event）、
  // 传输（桥接的事件队列）、消费者（面板的 renderBridgeEvent）。
  // 反向断言它们**不得复活** —— 这是删除清单第 4 步的核心约束。
  assert.ok(
    !fs.existsSync(path.join(ROOT, 'integrations/opencode/recallflow-mcp/panel-events.js')),
    'panel-events.js 应已删除'
  );
  assert.ok(!fs.existsSync(path.join(ROOT, 'integrations/dsh-hooks')), 'dsh-hooks（往 /event 推事件）应已删除');
  assert.ok(!/pushEvent\(/.test(mcpSource), 'MCP server 不应再投递面板事件');
  assert.ok(!/eventQueue/.test(mcpSource.replace(/^\s*(\/\/|\/\*|\*).*$/gm, '')), '不应再有事件队列（注释除外）');
  assert.ok(!/name === 'panel_post'/.test(mcpSource), 'panel_post 工具应已删除');
  assert.ok(!/name === 'panel_history'/.test(mcpSource), 'panel_history 工具应已删除');
  assert.ok(!/url\.pathname === '\/panel-turns'/.test(mcpSource), '/panel-turns 端点应已删除');
  assert.ok(!/url\.pathname === '\/event'/.test(mcpSource), '/event 端点应已删除');
  // 工具服务本身必须完好 —— 这是桥接现在唯一的职责
  assert.ok(/url\.pathname === '\/poll'/.test(mcpSource), '/poll 必须保留');
  assert.ok(/url\.pathname === '\/result'/.test(mcpSource), '/result 必须保留');
});

test('输入通道两端对齐（面板 → 后台 → DSH 插件），含 URL 路径契约', () => {
  // 这条链路跨两个包，出错时两端都静默（扩展刻意不抛、插件路径不对只 404），
  // 所以形状必须逐字钉住。
  const chat = fs.readFileSync(path.join(ROOT, 'lib/page/chat.js'), 'utf8');
  const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const relay = fs.readFileSync(path.join(ROOT, 'lib/bridge/relay.js'), 'utf8');
  const mcp = fs.readFileSync(MCP_INDEX, 'utf8');

  // 1) 面板发出 → 后台接收：消息 type 必须一致
  assert.ok(/type: 'panel:turn'/.test(chat), '面板应发出 panel:turn');
  assert.ok(/msg\.type === 'panel:turn'/.test(bg), '后台应处理 panel:turn');
  // 2) 后台 → relay：必须经 relay 的函数（而不是自己拼一份 URL）
  assert.ok(/sayToDsh\(/.test(bg), '后台应调用 sayToDsh');
  assert.ok(/export async function sayToDsh\(/.test(relay), 'relay 应导出 sayToDsh');
  assert.ok(!/export async function postPanelTurn\(/.test(relay), 'postPanelTurn 已删除，不应复活');

  // 3) 桥接那条通道本身必须保留（opencode 依赖它），且只剩工具调用两条路径。
  //    /panel-turns 与 /event 已随第 4 步移除。
  assert.ok(/async function httpLoop\(\)/.test(relay), '桥接长轮询必须保留（opencode 依赖桥接）');
  const relayPath = (relay.match(/RELAY_HTTP \+ '(\/[a-z-]+)'/g) || []).map((s) => s.match(/'(\/[a-z-]+)'/)[1]);
  assert.ok(relayPath.includes('/poll'), 'relay 应轮询 /poll（工具调用入口），实际：' + relayPath.join('、'));
  assert.ok(relayPath.includes('/result'), 'relay 应回传 /result，实际：' + relayPath.join('、'));
  assert.ok(/url\.pathname === '\/poll'/.test(mcp), 'MCP server 应实现 /poll');
  assert.ok(!relayPath.includes('/panel-turns'), '/panel-turns 已按删除清单移除，relay 不应再用它');

  // 4) 后台**只转发用户自己说的话**：助手输出不再推给 DSH ——
  //    新架构下回复本就来自那条会话，把助手输出当用户输入灌进去才是"冒充用户消息"。
  assert.ok(
    /if \(msg\.role !== 'user'\)/.test(bg),
    '后台应只转发 role 为 user 的面板输入（非 user 直接返回，不推给 DSH）'
  );
  assert.ok(!/name: 'panel_history'/.test(mcp), 'panel_history 工具应已删除');
  assert.ok(!/name: 'panel_post'/.test(mcp), 'panel_post 工具应已删除');
});

// 「注入端对齐」那条测试已随旧插件一起删除（删除清单第 3 步）。
// 它断言的是"插件用 Agent.inject 把面板对话注入模型上下文 + GET /panel-turns 读回合"——
// 那条路已被新架构取代：面板输入**本来就是**这条会话的用户消息，不需要注入。
// 新架构对应的契约在 tests/dsh-one-plugin.test.mjs（载荷 source.kind 必须是 'user'、
// agent.send 的 mode/wake 参数）与 tests/relay-panel-turn.test.mjs（sendToDsh 的发送端形状）。

// 从 DSH 会话回声回来的**助手回答**必须走 Markdown 渲染器。
//
// 真实事故（用户实测：「recallflow 的 md 渲染不对」）：appendExternalEntry 原来无条件
// `el.textContent = line`，于是从会话回显的 `**加粗**`、表格、代码块全部**原样露出来**，
// 而同一段话在左边的 DSH GUI 里是正常渲染的 —— 两个界面对同一段内容的呈现不一致。
// 修法：kind === 'assistant' 时交给 renderAnswer（面板本地回答用的同一个渲染器）。
test('面板 appendExternalEntry：助手消息走 Markdown，用户/工具行保持纯文本', () => {
  const chat = fs.readFileSync(path.join(ROOT, 'lib/page/chat.js'), 'utf8');
  const i = chat.indexOf('function appendExternalEntry(');
  assert.ok(i > 0, '应能找到 appendExternalEntry');
  const body = chat.slice(i, i + 1800);
  assert.ok(/function appendExternalEntry\(who, level, line, kind\)/.test(body), '应接收 kind 参数');
  assert.ok(/kind === 'assistant'/.test(body), "应对 kind === 'assistant' 走 Markdown");
  assert.ok(/renderAnswer\(/.test(body), '助手消息应交给 renderAnswer 渲染');
  assert.ok(/el\.textContent = line;/.test(body), '非助手行仍要保持纯文本（textContent）');
  // 调用点必须把 kind 传下去，否则助手消息会静默退化成纯文本
  assert.ok(/appendExternalEntry\(d\.who, '', d\.line, d\.kind\)/.test(chat), 'renderSessionEvent 应把 d.kind 传下去');
});

// 打开面板失败**不能让界面卡死**。
//
// openPanel 一开头就把悬浮气泡藏起来，然后在后面几百行里建面板 ——
// 中途任何一步抛异常，用户看到的就是「气泡消失了、面板也没出来」，
// 而且只能刷新页面才能再点开（用户实测报的正是这个现象）。
// 修法：openPanel 变成带 try 的安全外壳，异常时把气泡放回去并把原因显示出来。
test('面板 openPanel：异常必须恢复悬浮按钮，而不是把界面卡死', () => {
  const chat = fs.readFileSync(path.join(ROOT, 'lib/page/chat.js'), 'utf8');
  const i = chat.indexOf('function openPanel(');
  assert.ok(i > 0, '应能找到 openPanel');
  const body = chat.slice(i, i + 1400);
  assert.ok(/try\s*\{[\s\S]{0,200}openPanelInner\(/.test(body), 'openPanel 应是带 try 的安全外壳，内层叫 openPanelInner');
  assert.ok(/fab\.classList\.remove\('hidden'\)/.test(body), '异常路径必须把悬浮按钮放回去，否则界面卡在死状态');
  assert.ok(/showCitationHint\(/.test(body), '异常路径要把原因显示出来（扩展 console 捕获是空的，这是唯一能把错误带出来的路径）');
  assert.ok(chat.includes('function openPanelInner(x, y, docked)'), '内层实现应存在');
  // 用户在"扩展已重载但页面没刷新"时点按钮，必须**每次都**得到提示。
  // 原来 warnExtDead 只提示一次，之后完全静默 —— 用户实测就是"气泡不消失但面板打不开"。
  assert.ok(/warnExtDead\(true\);/.test(chat), '点击触发的失效提示必须 force=true（只提示一次会让人卡在完全静默里）');
  assert.ok(/if \(!force && extDeadWarned\) return;/.test(chat), 'warnExtDead 应支持 force 参数');
  assert.ok(/ext-dead/.test(chat), '失效状态要标在悬浮按钮上（持续可见，而不是一闪而过的提示）');
});

// `escAttr` 必须**恰好一处定义、在模块顶层、且早于第一次使用**。
//
// 真实事故（用户实测）：它原来只定义在 openPanel 内部某个函数里（局部 const），
// 而模块顶层的 userActionsHtml() 也用了它 → 面板一渲染对话就抛
// `ReferenceError: escAttr is not defined` → 表现为「气泡还在、面板永远打不开」。
// 这类"用了文件里别处存在的助手、但它在另一个作用域"的错，语法检查抓不到，
// 只有真的跑到那行才会炸 —— 所以这里用静态规则把它钉住。
test('chat.js：escAttr 恰好一处定义、在模块顶层、早于首次使用', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib/page/chat.js'), 'utf8');
  const lines = src.split('\n');
  const decls = [];
  lines.forEach((l, i) => {
    if (/const\s+escAttr\s*=/.test(l)) decls.push({ n: i + 1, indent: (l.match(/^\s*/) || [''])[0].length });
  });
  assert.equal(decls.length, 1, 'escAttr 应恰好定义一处（实际 ' + JSON.stringify(decls) + '）');
  assert.equal(decls[0].indent, 0, 'escAttr 必须在模块顶层（不能缩进在某个函数里）');
  const uses = [];
  lines.forEach((l, i) => {
    if (/escAttr\s*\(/.test(l) && !/const\s+escAttr\s*=/.test(l) && !/^\s*(\/\/|\*)/.test(l)) uses.push(i + 1);
  });
  assert.ok(uses.length > 0, '应能用到 escAttr');
  assert.ok(Math.min.apply(null, uses) > decls[0].n, '首次使用必须在定义之后（否则 const 的 TDZ 会抛）');
});

// 面板的发送按钮**不能静默丢弃**。
//
// 用户实测反馈：「点了发送没反应」—— 表现是字还留在输入框里、也没有任何提示，
// 看起来像按钮坏了。根因：send() 里本地 AI 正在流式输出时写着 `if (streaming) return;`，
// 直接返回，什么都不做。修法：改成给一条面板内提示并保留输入内容。
// 这条契约钉住"那个分支必须给出提示"，防止以后又被简化回裸 return。
test('面板 send()：本地 AI 回答中不能静默丢弃，必须给出提示', () => {
  const chat = fs.readFileSync(path.join(ROOT, 'lib/page/chat.js'), 'utf8');
  const i = chat.indexOf('function send()');
  assert.ok(i > 0, '应能找到 send()');
  const body = chat.slice(i, i + 1400);
  assert.ok(/if \(streaming\) \{/.test(body), 'streaming 分支应是一个带提示的代码块，而不是裸 return');
  assert.ok(/showCitationHint\(/.test(body), 'streaming 分支里必须给出提示（否则用户看到的就是"点了没反应"）');
  assert.ok(!/if \(streaming\) return;/.test(body), '不要退回静默丢弃的老写法');
  assert.ok(/cmdInput\.value = ''/.test(body), '正常路径仍要清空输入框');
});

// 结果加工只有一份实现 —— 这是"删掉 DSH 的 MCP client 会静默丢掉「元素 → 源码文件」"
// 那个缺口的防回归。
//
// 背景：源位置重写/元素源码成形原本**只在桥接的处理器里**，插件返回未加工的原始 JSON。
// 后来把这些抽到 lib/shared/（dev-paths / page-health / verify-change / tool-results），
// 插件与桥接都改成调用它。这条测试钉住"不许再各自内联写一份"。
//
// 断言方式：不是查"有没有 import"（那太弱），而是查**底层归一化函数在业务文件里是否还被直接调用**。
// 那些调用现在只应出现在 lib/shared 内部。数字是量过才写的（两个文件的实际计数）。
test('结果加工只有一份实现：桥接与插件都不再内联调用底层归一化函数', () => {
  const bridge = fs.readFileSync(MCP_INDEX, 'utf8');
  const plugin = fs.readFileSync(path.join(ROOT, 'integrations/dsh-plugin-recallflow-one/index.js'), 'utf8');

  // 两边都必须接入共享模块
  assert.ok(/lib\/shared\/tool-results\.js/.test(bridge), '桥接应 import 共享的 tool-results');
  assert.ok(/lib\/shared\/tool-results\.js/.test(plugin), '插件应 import 共享的 tool-results');

  // 桥接里不得再出现这些底层调用（共享模块体内才有）
  for (const fn of [
    'rewriteSourceUrls(',
    'normalizeElementSource(',
    'normalizePickedElement(',
    'normalizationHint(',
    'summarizePageHealth(',
    'evaluateTargets(',
    'incrementalHealth',
  ]) {
    assert.ok(!bridge.includes(fn), '桥接不应再内联调用 ' + fn + '（应经 lib/shared/tool-results.js）');
  }
  // 桥接应通过共享函数成形
  assert.ok(bridge.includes('shapeTextResult('), '桥接的 read_console/read_network 应调用 shapeTextResult');

  // 插件同理：不直接碰底层归一化，只调 applyToolResult
  for (const fn of ['rewriteSourceUrls(', 'normalizeElementSource(', 'normalizePickedElement(']) {
    assert.ok(!plugin.includes(fn), '插件不应直接调用 ' + fn + '（应走 applyToolResult）');
  }
  assert.ok(plugin.includes('applyToolResult('), '插件的工具结果应经 applyToolResult');
  // 有状态的两个方法必须拿调用方自己的游标（不是模块级全局）
  assert.ok(plugin.includes('toolCursors'), '插件应自己持有 page_health/verify_change 的游标');
});
