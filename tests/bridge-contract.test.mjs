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
  assert.ok(/name === 'page_screenshot'\)\s*return await pageScreenshot/.test(mcpSource), 'page_screenshot 必须在通用包装前单独分支（否则图片会被 JSON 化）');
  const store = fs.readFileSync(path.join(ROOT, 'integrations/opencode/recallflow-mcp/evidence-store.js'), 'utf8');
  assert.ok(/export function archiveImage\(/.test(store), 'evidence-store 应提供 archiveImage');
});
