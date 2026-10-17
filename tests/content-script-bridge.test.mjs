// 内容脚本桥：目标框架没有接收端时，补注入 content.js 再重试。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sendTabMessageWithInjection,
  __resetContentScriptBridgeForTests,
} from '../lib/shared/content-script-bridge.js';

function mkChrome(handler) {
  const chrome = {
    runtime: { lastError: null },
    tabs: {
      sendMessage(tabId, message, options, callback) {
        handler.send({ tabId, message, options, callback, chrome });
      },
    },
    scripting: {
      async executeScript(options) {
        handler.inject(options);
        return [{ result: true }];
      },
    },
  };
  return chrome;
}

test.beforeEach(() => {
  __resetContentScriptBridgeForTests();
});

test('Receiving end does not exist：向同一 frame 补注入 content.js 后重试成功', async () => {
  let sends = 0;
  const injected = [];
  const chrome = mkChrome({
    send({ options, callback, chrome }) {
      sends += 1;
      if (sends === 1) {
        chrome.runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
        callback();
        chrome.runtime.lastError = null;
        return;
      }
      chrome.runtime.lastError = null;
      callback({ version: 2, frameId: options.frameId });
    },
    inject(options) {
      injected.push(options);
    },
  });

  const out = await sendTabMessageWithInjection(chrome, 7, { type: 'kbGetPageSnapshot' }, 188);
  assert.equal(out.frameId, 188);
  assert.equal(sends, 2, '应在注入后重试一次');
  assert.deepEqual(injected, [
    { target: { tabId: 7, frameIds: [188] }, files: ['content.js'] },
  ]);
});

test('非内容脚本错误：不注入、直接原样抛出', async () => {
  let sends = 0;
  let injected = 0;
  const chrome = mkChrome({
    send({ callback, chrome }) {
      sends += 1;
      chrome.runtime.lastError = { message: '页面脚本主动报错' };
      callback();
      chrome.runtime.lastError = null;
    },
    inject() {
      injected += 1;
    },
  });

  await assert.rejects(
    sendTabMessageWithInjection(chrome, 7, { type: 'kbGetPageSnapshot' }, 0),
    /页面脚本主动报错/
  );
  assert.equal(sends, 1);
  assert.equal(injected, 0, '业务错误不得被误判成"没注入"');
});

test('补注入失败：保留原始不可达错误，不假装成功', async () => {
  let sends = 0;
  const chrome = mkChrome({
    send({ callback, chrome }) {
      sends += 1;
      chrome.runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
      callback();
      chrome.runtime.lastError = null;
    },
    inject() {
      throw new Error('Cannot access contents of the page');
    },
  });

  await assert.rejects(
    sendTabMessageWithInjection(chrome, 7, { type: 'kbGetPageSnapshot' }, 0),
    /Receiving end does not exist/
  );
  assert.equal(sends, 1, '注入失败后不应盲目重试消息');
});
