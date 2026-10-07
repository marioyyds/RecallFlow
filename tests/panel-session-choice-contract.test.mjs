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

test('panel:turn 的消息体：不带 sessionId（下拉已撤），但**带拾取的元素**', () => {
  // 正则放宽：加了注释与 elements 之后，消息体比原来长得多（原来写死 300 字符，一改就红）。
  const m = chat.match(/type: 'panel:turn',[\s\S]{0,900}?\n\s{8}\},/);
  assert.ok(m, '应能找到 panel:turn 的消息体');
  assert.ok(!/sessionId/.test(m[0]), 'panel:turn 的消息体里不该再有 sessionId：' + m[0]);
  // 元素是**只在非空时**带的 —— 没拾取时请求体与改动前一模一样。
  assert.match(
    m[0],
    /\.\.\.\(pickedElements\.length \? \{ elements: pickedElements \} : \{\}\)/,
    '拾取的元素必须随消息发出去（且只在非空时带）'
  );
});

test('后台不再为选择器服务；元素的第三个参数如实透传', () => {
  assert.ok(!bg.includes('panel:sessions'), 'background 不该再有 panel:sessions');
  // 下拉撤掉之后 msg.sessionId 永远是 undefined，但参数位保留 —— 同一处调用也送 elements。
  assert.match(bg, /sayToDsh\(text, msg\.sessionId, msg\.elements\)/, 'panel:turn 应把 elements 透传给 sayToDsh');
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
