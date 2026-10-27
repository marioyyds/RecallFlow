// 辅助标签页必须“先保存、后关闭”，否则最后一条回复只存在于即将销毁的面板 DOM。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const AGENT = fs.readFileSync(new URL('../lib/assistant/agent.ts', import.meta.url), 'utf8');
const CHAT = fs.readFileSync(new URL('../lib/page/chat.ts', import.meta.url), 'utf8');
const BACKGROUND = fs.readFileSync(new URL('../entries/background.js', import.meta.url), 'utf8');

function functionSlice(src, startNeedle, endNeedle) {
  const at = src.indexOf(startNeedle);
  assert.ok(at >= 0, '找不到 ' + startNeedle);
  const end = src.indexOf(endNeedle, at + startNeedle.length);
  assert.ok(end > at, '找不到结束锚点 ' + endNeedle);
  return src.slice(at, end);
}

test('Agent 收尾只登记辅助页，不直接关闭', () => {
  const body = functionSlice(AGENT, 'async function closeAuxTabs(', 'function emitTabsClosePending');
  assert.doesNotMatch(body, /chrome\.tabs\.remove\(/, 'closeAuxTabs 不得先于最终落盘直接关页');
  assert.doesNotMatch(body, /closeAgentWindow\(/, 'Agent 窗口也要延后关闭');
  assert.match(body, /pendingCloseTabs/, '必须把待关闭 tabs 交给后台');
  assert.match(AGENT, /type: 'tabs-close-pending'/, '必须发送待关闭事件');
});

test('发起页在最终保存成功后发送 committed ack', () => {
  const body = functionSlice(CHAT, 'function endStream()', '// 移除初始的“正在输入”占位元素');
  assert.match(body, /panelSessionSaveChain/);
  assert.match(body, /saved && saved\.ok/, '只有保存成功才能确认可清理');
  assert.match(body, /panel:run:committed/, '必须通知后台最终消息已落盘');
  assert.ok(
    body.indexOf("panel:run:committed") > body.indexOf('await releasePanelSessionLock()'),
    'ack 必须在最终保存链内、释放运行锁之后发送'
  );
});

test('后台收到 committed 后才关闭辅助页，并保留超时兜底', () => {
  assert.match(BACKGROUND, /msg\.type === 'panel:run:committed'/, '缺少 committed 路由');
  assert.match(BACKGROUND, /function finalizeRunCleanup\(runId\)/);
  assert.match(BACKGROUND, /15_000/, '发起页崩溃时必须有兜底关闭');
  assert.match(BACKGROUND, /chrome\.tabs\.remove\(ids/, '真正关页发生在后台收尾');
});
