// 面板「选择跟哪条 DSH 会话说话」——**已按用户要求撤掉**。这里钉住两件事：
//   ① 它不再回来（撤的时候极易漏掉某一处）；
//   ② 撤掉之后，**默认路径与接线前完全一致**。
//
// 为什么值得留一条"撤掉了"的测试：这个功能确实被完整接线进去过（选择器 + 持久化 + 事件过滤），
// 而撤的时候有个**会让人启动即报错**的陷阱 —— 那段 `chrome.storage.local.get(...)`
// 是模块加载时**立即执行**的，留着它引用已删的 `chosenSessionId` 就会 ReferenceError。
// 静态断言能把"撤干净"变成可复现的检查，而不是靠人记得。
//
// 为什么撤（实测数据，不是口味问题）：17 条会话里**只有 1 条是 `live: true`**
// （只有载入过的会话才拿得到 agent），侧边栏那些一条都发不进去 ——
// 选择器可列全、却几乎不可用，不值得那份复杂度。
// 插件侧的 `/say` `sessionId` 与 `/status` 的 `sessionList` **刻意保留**：
// 默认路径一个字节都没变、且都有测试；将来想启用，把面板那几行加回来即可。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const chat = read('lib/page/chat.js');
const bg = read('background.js');
const css = read('lib/page/panel-css.js');

test('面板里不应再有会话选择器的任何痕迹', () => {
  for (const needle of [
    'session-choice.js',
    'chosenSessionId',
    'knownSessions',
    'dshCurrentSessionId',
    'sessionChooserEl',
    'ensureSessionChooser',
    'renderSessionChooser',
    'refreshSessionChoices',
    'shouldRenderSessionFrame',
    'rf-session-chooser',
    'recallflow.dshSession',
    "type: 'panel:sessions'",
  ]) {
    assert.ok(!chat.includes(needle), 'chat.js 里不该再出现 ' + needle + '（撤的时候漏了一处？）');
  }
});

test('panel:turn 的消息体：不带 sessionId（下拉已撤），但**带拾取的元素**（且已在面板侧裁过）', () => {
  // **不再靠"截取整段消息体"** —— 那个写法已经因为这个测试红过两次：
  // 一加注释/字段，窗口就不够长（先 300、后 900），红的是测试而不是代码。
  // 改成钉四条各自独立、不会被长度影响的事实：
  assert.ok(!/sessionId/.test(chat), 'chat.js 里不该再出现 sessionId（下拉已撤）');
  assert.match(chat, /\.\.\.\(pickedElements\.length/, '拾取的元素必须随消息发出去（只在非空时带）');
  assert.match(chat, /pickedElements\.slice\(0, 8\)/, '面板侧必须先限制个数（防超长消息让 sendMessage 直接抛）');
  assert.match(chat, /String\(el\.text\)\.slice\(0, 200\)/, '长文本要在面板侧截断');
});

test('后台不再为选择器服务；元素的第三个参数如实透传', () => {
  assert.ok(!bg.includes('panel:sessions'), 'background 不该再有 panel:sessions');
  // 下拉撤掉之后 msg.sessionId 永远是 undefined，但参数位保留 —— 同一处调用也送 elements。
  assert.match(bg, /sayToDsh\(text, msg\.sessionId, msg\.elements\)/, 'panel:turn 应把 elements 透传给 sayToDsh');
});

test('发送成功后要**清掉拾取的元素并重画 chip**（真机：chip 不消失，之后每条消息都带着它）', () => {
  // 用户报的："虽然发送成功了，但是 chip 不会随发送消失"。
  // 机制：发送时把 pickedElements 带上去了，但从来没清空 —— 于是拾取一次之后
  // **之后每一条消息都继续带着同一个元素**，chip 也一直挂着。
  assert.match(chat, /pickedElements = \[\];\s*\n\s*renderPick\(\);/, '发送成功后必须清空并重画 chip');
  // 顺序：清理要发生在**发送成功之后**（失败路径 return 掉，元素留着让用户重试）。
  // 注意：文件里前面还有别的 pickedElements 清空处（清空对话、重开面板），
  // 所以要从**直送调用之后**往后找，不能用 indexOf 拿第一个。
  const iSend = chat.indexOf('sendPanelTurn(turn)');
  const iClear = chat.indexOf('pickedElements = [];', iSend);
  assert.ok(iSend > 0 && iClear > iSend, '清理必须在直送调用**之后**（即成功回调里）');
});

test('直送前必须**先**推进推送游标 —— 否则回声会把你那句话再发一遍（真机：会话里出现两条）', () => {
  // 真机 bug（2026-10-08）：用户在面板发一句话，会话里出现**两条**，
  // 插件日志里 "[recallflow-one] 面板输入已送入会话" 打了两次。
  // 机制：sendPanelTurn 是异步的，而 syncPushCursor() 原来只写在 `.then()` 里（响应回来之后）；
  // 回声走的是 WS、可能先到 → renderSessionEvent(mark-local) → saveConversation() →
  // pushPanelTurnIfNew() 看到的还是**发送前**的游标 → 这条被当成没推过 → 再发一遍。
  const i = chat.indexOf('sendPanelTurn(turn)');
  assert.ok(i > 0, '应能找到面板的直送调用 sendPanelTurn(turn)');
  const before = chat.slice(Math.max(0, i - 900), i);
  assert.match(
    before,
    /syncPushCursor\(\);/,
    'syncPushCursor() 必须在 sendPanelTurn(turn) **之前**调用（否则 WS 回声先到时会重复发送）'
  );
  // 反向：不能把游标推进放在发送之后的 then 里当唯一防线
  assert.ok(
    !/sendPanelTurn\(turn\)\s*\n\s*\.then\([\s\S]{0,400}?syncPushCursor\(\);/.test(chat) ||
      /syncPushCursor\(\);\s*\n\s*sendPanelTurn\(turn\)/.test(chat),
    '发送前那处不能缺'
  );
});

test('选择器的样式也撤了（不留死样式）', () => {
  assert.ok(!css.includes('rf-session-chooser'), 'panel-css.js 里不该再有 rf-session-chooser');
});

test('撤干净了：relay 与插件的会话/元素能力**仍然保留**（默认路径不受影响）', () => {
  const relay = read('lib/bridge/relay.js');
  assert.match(
    relay,
    /export async function sayToDsh\(text, sessionId, elements\)/,
    'relay 仍接受可选的 sessionId 与 elements'
  );
  // elements 只在非空时进请求体（不拾取 = 请求体与以前一模一样）
  assert.match(relay, /if \(els\.length\) payload\.elements = els;/, 'elements 不应无条件放进请求体');
  const plugin = read('integrations/dsh-plugin-recallflow-one/index.js');
  assert.match(plugin, /sessionList: listAllSessions\(\)/, '插件的 /status 仍报会话列表（面板不用，但它是可观测接口）');
  assert.match(plugin, /findSessionStrict/, '插件的严格查找仍在（默认路径不走它，但指定了不存在 id 时绝不回退）');
});
