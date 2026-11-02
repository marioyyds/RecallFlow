// fab:show 的**回包契约**：内容脚本必须回答「我收到了」，弹窗才敢说"已显示"。
//
// 为什么要有这个文件：这条消息是 popup 里唯一需要"送达确认"的指令，而它此前
// 走的是「不接 sendResponse、return false」的监听器 —— 通道被关掉，发送端回调收到
// "The message port closed before a response was received"，于是一个**已经成功**的
// 操作被报成「无法显示悬浮球，请刷新页面后重试」（真机复现，见 tests/e2e/fab-show.spec.mjs）。
// 静态门禁看不到这件事：return false 是合法 JS，只有真发一次消息才暴露。
//
// 这里用与 chat-panel-smoke 同一套 DOM/chrome stub 真 import chat.ts，
// 触发监听器并断言它**返回 true 且 sendResponse 收到 {ok:true}**。
import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub } from './helpers/dom-stub.mjs';
import { installChrome, restoreChrome } from './helpers/chrome-stub.mjs';
import { createChromeRuntimeAdapter } from '../lib/adapters/chrome/runtime.ts';

const FAB_HIDDEN_KEY = 'recallflow.fab.hidden.v1';
let seq = 0;

/** 与真实入口对齐地起一份 chat.ts（见 entries/content.ts 的 initAssistant 调用）。 */
async function boot(chromeOpts = {}) {
  const dom = installDomStub();
  const prevChrome = installChrome(chromeOpts);
  const mod = await import('../lib/ui/page/chat.ts?fabcontract=' + (seq += 1));
  const { createChromeStorageAdapter } = await import('../lib/adapters/chrome/storage.ts');
  mod.initAssistant({
    runtime: createChromeRuntimeAdapter(),
    storage: createChromeStorageAdapter(globalThis.chrome.storage.local, globalThis.chrome),
  });
  return {
    mod,
    dom,
    chrome: globalThis.chrome,
    close() { dom.restore(); restoreChrome(prevChrome); },
  };
}

async function waitFor(predicate, label, timeoutMs = 500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const v = predicate();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail('等待超时：' + label);
}

test('fab:show：监听器必须回包 {ok:true} 并保持通道打开（否则弹窗把成功报成失败）', async () => {
  const app = await boot();
  try {
    const reply = { called: false, value: undefined };
    const returns = app.chrome._emitMessage({ type: 'fab:show' }, { id: 'popup' }, (value) => {
      reply.called = true;
      reply.value = value;
    });
    assert.equal(reply.called, true, 'sendResponse 必须被调用 —— 不回话 = 发送端拿不到送达确认');
    assert.equal(reply.value && reply.value.ok, true, '回包必须是 {ok:true}');
    assert.ok(returns.includes(true), '监听器必须 return true，否则 Chrome 会立刻关掉消息通道');
  } finally {
    app.close();
  }
});

test('fab:show：找回动作本身还要清掉"隐藏"偏好并重建悬浮球', async () => {
  const app = await boot({ local: { [FAB_HIDDEN_KEY]: { hidden: true, updatedAt: 1 } } });
  try {
    const shadow = () => app.dom.document.documentElement.querySelector('#__kb-ai-host').shadowRoot;
    await waitFor(() => !shadow().querySelector('.fab'), '初始状态：偏好为隐藏 ⇒ 不应有悬浮球');
    app.chrome._emitMessage({ type: 'fab:show' }, { id: 'popup' }, () => {});
    const fab = await waitFor(() => shadow().querySelector('.fab'), '收到 fab:show 后悬浮球必须回来');
    assert.ok(fab, '悬浮球重建失败');
    const stored = await globalThis.chrome.storage.local.get([FAB_HIDDEN_KEY]);
    assert.equal(stored[FAB_HIDDEN_KEY].hidden, false, '偏好必须落盘为"不隐藏"（其它标签页靠它一起回来）');
  } finally {
    app.close();
  }
});