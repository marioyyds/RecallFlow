// 桥接契约门禁：MCP server 调用的方法名 必须与 扩展 relay 支持的方法名 一致。
//
// 为什么需要：这条链路（真实浏览器会话、页面健康、截图）横跨两个包，
// 且**最难手工回归** —— 方法名拼错/改名只会在运行时表现为 "unknown method"，
// 而那时用户已经在等结果了。这里在提交前就把它变成红灯。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { BRIDGE_METHODS, isBridgeMethod } from '../lib/shared/bridge-methods.js';

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
