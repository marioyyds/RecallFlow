// 扩展侧结构化采集器：用 chrome.tabs 桩驱动真实分发逻辑。
// 这层此前只有纯函数级测试（planFrameBatches），这里验证 Promise.all 合并、
// 顺序还原、单框架失败隔离，以及 get_element_source 的向后兼容字段。
import test from 'node:test';
import assert from 'node:assert/strict';

import { collectElementSource, verifyPageTargets, collectPageDiagnostics } from '../lib/assistant/tools.js';

// 安装 chrome.tabs 桩；handler 决定每个消息返回什么。
function installTabs(handler) {
  const calls = [];
  globalThis.chrome = {
    runtime: { lastError: null },
    tabs: {
      sendMessage(tabId, message, options, callback) {
        // 真实 chrome 语义：lastError 只在本次失败回调期间有效，下次调用前即为空。
        // 桩若不每次清空，失败会「泄漏」到后续调用，产生假失败。
        globalThis.chrome.runtime.lastError = null;
        const frameId = options && options.frameId;
        calls.push({ tabId, type: message && message.type, frameId, params: message && message.params });
        const out = handler(message, frameId, calls.length);
        callback(out);
      },
    },
  };
  return calls;
}

// 模拟 sendMessage 失败（真实 API 通过 runtime.lastError 报错）
function failWith(message) {
  globalThis.chrome.runtime.lastError = { message };
  return undefined;
}

test.afterEach(() => {
  globalThis.chrome = undefined;
});

// ---------------------------------------------------------------- get_element_source

test('collectElementSource: 同时返回结构化 source 与兼容字段 text', async () => {
  installTabs(() => ({
    found: true,
    selector: 'button#submit',
    source: { framework: 'react', component: 'Submit', file: 'http://localhost:5173/src/S.tsx', line: 42, column: 7 },
  }));
  const r = await collectElementSource(1, { selector: '#submit' });
  assert.equal(r.found, true);
  assert.equal(r.source.file, 'http://localhost:5173/src/S.tsx');
  assert.equal(r.source.line, 42);
  assert.equal(r.selector, 'button#submit');
  // 旧版 MCP server 只认 text，格式必须与改动前一致
  assert.equal(r.text, '元素源码位置：http://localhost:5173/src/S.tsx:42:7（react · Submit）\n选择器：button#submit');
});

test('collectElementSource: 无 framework 时 text 不带括号后缀', async () => {
  installTabs(() => ({ found: true, selector: '#a', source: { file: 'http://x/A.tsx', line: 3 } }));
  const r = await collectElementSource(1, {});
  assert.equal(r.text, '元素源码位置：http://x/A.tsx:3\n选择器：#a');
});

test('collectElementSource: 未找到时透传 reason 且不带 text', async () => {
  installTabs(() => ({ found: false, selector: '#a', reason: '未检测到框架源码信息' }));
  const r = await collectElementSource(1, {});
  assert.equal(r.found, false);
  assert.equal(r.reason, '未检测到框架源码信息');
  assert.equal(r.text, undefined);
});

test('collectElementSource: 无 tabId 直接返回，不触碰 chrome', async () => {
  const calls = installTabs(() => ({}));
  const r = await collectElementSource(null, {});
  assert.equal(r.found, false);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------- verify_change 分发

test('verifyPageTargets: 按框架分组并还原原始顺序', async () => {
  const calls = installTabs((message, frameId) => {
    if (frameId === 0) {
      return { targets: [{ found: true, count: 1, selector: '#top' }, { found: true, count: 1, selector: '#also' }] };
    }
    if (frameId === 2) {
      return { targets: [{ found: true, count: 1, selector: '#in2' }] };
    }
    return { targets: [] };
  });
  const targets = [{ selector: '#top' }, { ref: 'f2:rf-1' }, { selector: '#also' }];
  const r = await verifyPageTargets(7, targets);
  assert.equal(r.found, true);
  assert.equal(r.targets.length, 3);
  // 顺序必须与传入一致，不能按框架分组后的顺序
  assert.deepEqual(r.targets.map((t) => t.selector), ['#top', '#in2', '#also']);
  // 且只应向 0 与 2 两个框架发消息
  const frames = calls.map((c) => c.frameId).sort();
  assert.deepEqual(frames, [0, 2]);
  // f2: 前缀必须被剥离后才发给子框架
  const frame2Call = calls.find((c) => c.frameId === 2);
  assert.equal(frame2Call.params.targets[0].ref, 'rf-1');
});

test('verifyPageTargets: 单个框架失败不影响其它框架的结果（失败隔离）', async () => {
  installTabs((message, frameId) => {
    if (frameId === 5) return failWith('No frame with id 5');
    return { targets: [{ found: true, count: 1, selector: '#ok' }] };
  });
  const r = await verifyPageTargets(7, [{ selector: '#ok' }, { selector: '#bad', frameId: 5 }]);
  assert.equal(r.targets.length, 2);
  assert.equal(r.targets[0].selector, '#ok');
  assert.equal(r.targets[0].found, true);
  assert.equal(r.targets[1].found, false);
  assert.equal(r.targets[1].count, 0);
  assert.ok(r.targets[1].reason.includes('框架 5'), r.targets[1].reason);
  assert.ok(r.targets[1].reason.includes('No frame with id 5'), r.targets[1].reason);
});

test('verifyPageTargets: 框架返回条数不足时补「未返回结果」，不越界', async () => {
  installTabs(() => ({ targets: [{ found: true, count: 1, selector: '#only' }] }));
  const r = await verifyPageTargets(7, [{ selector: '#a' }, { selector: '#b' }]);
  assert.equal(r.targets.length, 2);
  assert.equal(r.targets[0].selector, '#only');
  assert.ok(String(r.targets[1].reason).includes('未返回结果'), r.targets[1].reason);
});

test('verifyPageTargets: 空目标与无 tabId 都安全', async () => {
  installTabs(() => ({ targets: [] }));
  const empty = await verifyPageTargets(7, []);
  assert.deepEqual(empty.targets, []);
  const noTab = await verifyPageTargets(null, [{ selector: '#a' }]);
  assert.equal(noTab.found, false);
});

// ---------------------------------------------------------------- page_health 采集

test('collectPageDiagnostics: 返回结构化 console 与 network 原始条目', async () => {
  installTabs((message) => {
    if (message.type === 'kbGetConsole') return { entries: [{ level: 'error', text: 'boom', at: 100 }] };
    if (message.type === 'kbGetNetwork') return { entries: [{ url: 'http://x/api', status: 500, at: 101 }] };
    return {};
  });
  const r = await collectPageDiagnostics(3);
  assert.equal(r.console.length, 1);
  assert.equal(r.console[0].level, 'error');
  assert.equal(r.network.length, 1);
  assert.equal(r.network[0].status, 500);
});

test('collectPageDiagnostics: 某一通道失败时记录错误但不抛，另一通道仍可用', async () => {
  installTabs((message) => {
    if (message.type === 'kbGetConsole') return failWith('无内容脚本');
    return { entries: [{ url: 'http://x/api', status: 200, at: 1 }] };
  });
  const r = await collectPageDiagnostics(3);
  assert.deepEqual(r.console, []);
  assert.ok(String(r.consoleError).includes('无内容脚本'), r.consoleError);
  assert.equal(r.network.length, 1, 'network 通道不应受 console 失败影响');
});
