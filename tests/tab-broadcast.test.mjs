// 面板广播的送达兜底：只对「没有接收端」补注入 content.js，且同一标签页不反复注入。
//
// 这段逻辑为什么值得单测：它是扩展重载后「切到旧标签页，面板与嵌入层不跟过来」的唯一修复点，
// 而它的两个错误方向都**不会报错**——多注入是白烧 CPU 与脚本执行，少注入是静默不跟随。
// 尤其 "message port closed" 这条：它表示接收端活着、只是没回话（见 background.ts 里
// sendToRunSubscribers 的同款注释），对它补注入等于把真问题掩盖成"脚本没加载"。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createTabBroadcaster, INJECT_COOLDOWN_MS } from '../lib/shared/tab-broadcast.ts';

/** 手写替身：这里要精确控制 lastError 的时机，chrome-stub 的 async 版做不到。 */
function mkChrome({ errorMessage = null } = {}) {
  const sends = [];
  const injections = [];
  const chrome = {
    runtime: { lastError: null },
    tabs: {
      sendMessage(tabId, message, options, callback) {
        sends.push({ tabId, message, options });
        chrome.runtime.lastError = errorMessage ? { message: errorMessage } : null;
        callback();
        // 真机上 lastError 只在回调期间有效，回调返回后即为 undefined。
        chrome.runtime.lastError = null;
      },
    },
    scripting: {
      async executeScript(options) {
        injections.push(options);
        return [{ result: true }];
      },
    },
  };
  return { chrome, sends, injections };
}

test('正常送达：不注入 content.js', () => {
  const { chrome, sends, injections } = mkChrome();
  const broadcaster = createTabBroadcaster(chrome);
  broadcaster.send(7, { type: 'panel:ui-changed', open: true });

  assert.equal(sends.length, 1);
  assert.equal(sends[0].tabId, 7);
  assert.deepEqual(sends[0].options, { frameId: 0 }, '只给顶层框架发广播');
  assert.equal(injections.length, 0);
});

test('没有接收端：补注入 content.js 一次（顶层框架）', () => {
  const { chrome, injections } = mkChrome({ errorMessage: 'Could not establish connection. Receiving end does not exist.' });
  const broadcaster = createTabBroadcaster(chrome);
  broadcaster.send(7, { type: 'panel:sessions-changed' });

  assert.equal(injections.length, 1);
  assert.deepEqual(injections[0], { target: { tabId: 7, frameIds: [0] }, files: ['content.js'] });
});

test('端口关闭不算没有接收端：不注入', () => {
  const { chrome, injections } = mkChrome({
    errorMessage: 'The message port closed before a response was received.',
  });
  const broadcaster = createTabBroadcaster(chrome);
  broadcaster.send(7, { type: 'panel:ui-changed' });

  assert.equal(injections.length, 0, '接收端活着只是没回话，注入只会在页面里叠出第二套 UI');
});

test('冷却：同一标签页的后续广播不重复注入，冷却结束后可以再注入一次', () => {
  const { chrome, injections } = mkChrome({ errorMessage: 'Could not establish connection. Receiving end does not exist.' });
  const broadcaster = createTabBroadcaster(chrome);

  broadcaster.send(7, { type: 'a' });
  broadcaster.send(7, { type: 'b' });
  broadcaster.send(7, { type: 'c' });
  assert.equal(injections.length, 1, `${INJECT_COOLDOWN_MS}ms 内重复注入只会白跑 content.js`);

  // 不同标签页各算各的冷却。
  broadcaster.send(8, { type: 'a' });
  assert.equal(injections.length, 2);

  broadcaster.reset();
  broadcaster.send(7, { type: 'd' });
  assert.equal(injections.length, 3);
});

test('无效 tabId 直接忽略（标签页刚被关掉时 query 结果可能带 0/undefined）', () => {
  const { chrome, sends } = mkChrome();
  const broadcaster = createTabBroadcaster(chrome);

  broadcaster.send(0, { type: 'x' });
  broadcaster.send(-1, { type: 'x' });
  broadcaster.send(undefined, { type: 'x' });
  assert.equal(sends.length, 0);
});