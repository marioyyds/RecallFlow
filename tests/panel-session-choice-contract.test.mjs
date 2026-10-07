// 面板「选择跟哪条 DSH 会话说话」的**接线契约**（静态）。
//
// 为什么还要一条静态的：纯逻辑（lib/shared/session-choice.js）有 8 条行为测试，
// 但那些测试**证明不了面板真的在用它**。这个仓库里已经吃过一次同类教训
// （`escAttr is not defined`：函数在，调用点在另一个作用域，界面一渲染就炸）。
// 所以这里断言"接线存在且方向正确"，尤其是那条最容易写错的默认行为：
// **未指定时，请求体里不许出现 sessionId** —— 否则这次改动就动到了所有既有用法。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const chat = read('lib/page/chat.js');
const bg = read('background.js');
const relay = read('lib/bridge/relay.js');

test('面板导入了会话选择的纯逻辑（而不是自己再写一套判断）', () => {
  assert.match(chat, /from '\.\.\/shared\/session-choice\.js'/, 'chat.js 应从 session-choice.js 导入');
  for (const fn of ['shouldRenderSessionFrame', 'sortSessionChoices', 'describeSessionChoice', 'chosenStillExists', 'shortSessionId']) {
    assert.match(chat, new RegExp('\\b' + fn + '\\b'), 'chat.js 应使用 ' + fn);
  }
});

test('默认是"未指定"：初始值为空串，且未指定时请求体里不出现 sessionId', () => {
  assert.match(chat, /let chosenSessionId = '';/, '初始值必须是空串（未指定 = 旧行为）');
  assert.match(
    chat,
    /\.\.\.\(chosenSessionId \? \{ sessionId: chosenSessionId \} : \{\}\)/,
    'panel:turn 必须在**选了才带** sessionId —— 这样未指定时请求体与改动前完全一致'
  );
  // 反向：不能改成无条件带上（那会让默认路径也带一个空 sessionId，插件的严格分支会 404）
  assert.ok(
    !/type: 'panel:turn',[\s\S]{0,200}?sessionId: chosenSessionId,\n\s+pageUrl/.test(chat),
    'sessionId 不能无条件带上'
  );
});

test('会话事件按选中的会话过滤（切了会话不许混进别的会话的消息）', () => {
  assert.match(
    chat,
    /if \(!shouldRenderSessionFrame\(frame, chosenSessionId\)\) return;/,
    'renderSessionEvent 开头必须用纯函数过滤'
  );
});

test('选择持久化，且默认（未指定）时存的是空串', () => {
  assert.match(chat, /chrome\.storage\.local\.set\(\{ 'recallflow\.dshSession': chosenSessionId \}\)/, '选中后要持久化');
  assert.match(chat, /chrome\.storage\.local\.get\(\['recallflow\.dshSession'\]/, '打开时要读回');
});

test('选择器要在 append 之后才创建（否则 bindingEl 没有 parentNode，选择器根本插不进去）', () => {
  // 真实事故：芯片是 `const bindBtn = …; bindingEl = bindBtn; renderBindingChip();` 建的，
  // 而 append 发生在几行之后。只靠 renderBindingChip 顺手调 ensureSessionChooser 的话，
  // 那一刻 parentNode 还是 null → 选择器从未被创建 → 用户侧全部表现就是"不能选择"。
  const iAppend = chat.indexOf('head.appendChild(bindBtn);');
  assert.ok(iAppend > 0, '应能找到 head.appendChild(bindBtn)');
  const iEnsure = chat.indexOf('ensureSessionChooser();', iAppend);
  assert.ok(iEnsure > iAppend, 'ensureSessionChooser() 必须在 head.appendChild(bindBtn) **之后**被调用');
  assert.ok(
    iEnsure - iAppend < 400,
    '两者应当紧挨着（插入位置就落在 append 这里），实际相隔 ' + (iEnsure - iAppend) + ' 字符'
  );
});

test('选中的会话不在列表里时要看得见（不能悄悄掉回"跟随最近活跃"）', () => {
  assert.match(chat, /不在当前列表里/, '下拉里要补一个标明"不在当前列表里"的选项');
  assert.match(chat, /data-state', missing \? 'missing'/, '要用 data-state 标出这个状态（样式与排查都靠它）');
});

test('后台：panel:sessions 取列表、panel:turn 透传 sessionId', () => {
  assert.match(bg, /msg\.type === 'panel:sessions'/, 'background 应有 panel:sessions');
  assert.match(bg, /sessionList/, '应优先用插件新给的 sessionList（带 lastAt）');
  assert.match(bg, /sayToDsh\(text, msg\.sessionId\)/, 'panel:turn 要把 sessionId 透传给 sayToDsh');
});

test('relay：sayToDsh 接受第二个参数，且失败时把原因带回来', () => {
  assert.match(relay, /export async function sayToDsh\(text, sessionId\)/, 'sayToDsh 必须接受 sessionId');
  assert.match(relay, /sessionId: sid \} : \{ text: t \}/, '只在指定了会话时才放进请求体');
  assert.match(relay, /error: \(body && body\.error\) \|\| ''/, '失败原因要原样带回（否则面板只能显示"没反应"）');
});
